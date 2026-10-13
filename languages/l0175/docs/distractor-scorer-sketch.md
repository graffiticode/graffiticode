<!-- SPDX-License-Identifier: CC-BY-4.0 -->
# Design sketch: dspy-service distractor scorer (future enhancement)

Status: **sketch / not implemented.** Captured for later.

## Why

Distractor selection is L0175's killer feature. Today `selectDistractorClaims`
(`packages/core/src/compiler.ts`) does error-type coverage + a hand-tuned linear
`plausibility()` score (graph signals) + an optional author `plausibility` override. The
author override is the **seam** for something much stronger upstream: an LLM/embedding-backed
scorer that ranks foils by real misconception-targeting, semantic distinctness, and
*correctness-of-being-wrong* — while the compiler stays pure and deterministic.

The plan: vectors enrich the **authoring** step, not `compose`. An upstream scorer annotates
the `.gc` program with per-distractor `plausibility` (and misconception/error-type tags);
`compose` consumes the baked-in scores deterministically. Embeddings + the LLM judge run once
at authoring time, so the compiled item stays reproducible.

```
LLM generates a large, diverse candidate pool (passage + key + misconception bank)
  → /score-distractors: embed + score (plausibility, validity/NLI, misconception, MMR-novelty)
  → console writes plausibility/error-type onto distractor claims; drops rejected
  → deterministic compiler does coverage+MMR selection over the scored pool
  → deploy → collect responses → re-fit difficulty model + re-embed bank  ⟲
```

## Endpoint: `POST /score-distractors`

Fits the existing FastAPI/Pydantic/DSPy service (`dspy-service/src/api/`, `src/scorers/`),
same `{success, data, error}` envelope as `/compile-prompt-spec`.

### Request / response

```jsonc
// request
{
  "dialect": "0175",
  "passage": [{ "id": 1, "text": "Mara crouched at the edge of the tide pool…" }],
  "key": { "id": "c1", "text": "Mara is more interested in the tide pool than the picnic.",
           "dimension": "character", "evidence": ["Mara crouched…", "she smiled…"] },
  "candidates": [{ "id": "c2", "text": "Mara is angry at her brother.", "error_type": "misreads-detail" }],
  "target": { "item_type": "ebsr", "dok": "r-dok3", "slots": 3, "difficulty": 0.7 }
}

// response
{ "success": true,
  "data": {
    "scores": [
      { "id": "c2", "plausibility": 0.82, "error_type": "misreads-detail",
        "misconception": "reads quiet absorption as negative emotion", "misconception_similarity": 0.79,
        "entailed_by_evidence": false, "entailment_confidence": 0.93,
        "too_similar_to_key": false, "nearest_option_similarity": 0.88, "flags": [], "notes": null }
    ],
    "recommended": ["c2", "c3", "c4"],   // MMR: error-type/misconception coverage, deduped
    "rejected": ["c7"]                   // entailed by evidence → accidentally correct
  },
  "error": null }
```

## Pipeline (`src/scorers/distractor_scorer.py`)

1. **Embed** key, each evidence line, each candidate, and the **misconception bank** (cache by text hash).
2. **Validity gate (NLI, DSPy):** does the evidence *entail* the candidate? `entailed → reject`
   (it would be a second correct answer). The part embeddings can't do — the LLM judges it.
3. **Misconception match:** nearest bank entry by cosine → label + similarity; assigns/validates
   `error_type`; below threshold → `flags:["off-misconception"]`.
4. **Plausibility:** `w₁·cos(cand,key) + w₂·cos(cand,evidence) + w₃·misconception_sim + prior[error_type]`,
   clamped to [0,1] — the embedding version of today's heuristic.
5. **Distinctness:** cosine vs key (`too_similar_to_key`) and pairwise (for MMR + redundancy flags).
6. **Selection:** MMR over gate-passing candidates, constrained to cover error types / misconception
   clusters, sized to `slots`, biased toward `difficulty` (sets MMR λ).

## Key code

```python
# src/api/models.py (additions)
class PassageLine(BaseModel):
    id: int; text: str

class KeyClaim(BaseModel):
    id: str; text: str; dimension: str
    evidence: list[str] = Field(default_factory=list)

class CandidateDistractor(BaseModel):
    id: str; text: str
    error_type: str | None = None

class ScoringTarget(BaseModel):
    item_type: Literal["ebsr", "hot-text", "short-text"] = "ebsr"
    dok: str = "r-dok3"
    slots: int = 3
    difficulty: float | None = None

class ScoreDistractorsRequest(BaseModel):
    dialect: str = "0175"
    passage: list[PassageLine]
    key: KeyClaim
    candidates: list[CandidateDistractor]
    target: ScoringTarget = Field(default_factory=ScoringTarget)

class DistractorScore(BaseModel):
    id: str
    plausibility: float
    error_type: str
    misconception: str | None = None
    misconception_similarity: float | None = None
    entailed_by_evidence: bool = False
    entailment_confidence: float = 0.0
    too_similar_to_key: bool = False
    nearest_option_similarity: float | None = None
    flags: list[str] = Field(default_factory=list)
    notes: str | None = None

class ScoredPool(BaseModel):
    scores: list[DistractorScore]
    recommended: list[str]
    rejected: list[str]

class ScoreDistractorsResponse(BaseModel):
    success: bool; data: ScoredPool | None; error: str | None
```

```python
# src/scorers/signatures.py — the LLM-judged pieces (embeddings can't do these)
import dspy
from typing import Literal

class EntailmentJudge(dspy.Signature):
    """Decide whether the passage evidence makes the statement TRUE/entailed,
    a DEFENSIBLE-but-not-stated inference, or UNSUPPORTED. 'entailed' => the statement
    is actually correct and must NOT be used as a distractor."""
    evidence: str = dspy.InputField()
    statement: str = dspy.InputField()
    verdict: Literal["entailed", "defensible", "unsupported"] = dspy.OutputField()
    confidence: float = dspy.OutputField()

class MisconceptionTagger(dspy.Signature):
    """Name the student misconception a wrong inference targets and its SBAC error type."""
    passage: str = dspy.InputField()
    key: str = dspy.InputField()
    distractor: str = dspy.InputField()
    misconception: str = dspy.OutputField()
    error_type: Literal["misreads-detail", "erroneous-inference", "faulty-reasoning"] = dspy.OutputField()
```

```python
# src/scorers/distractor_scorer.py (core)
async def score_distractor_pool(req: ScoreDistractorsRequest) -> ScoredPool:
    emb = get_embedder()                                   # sentence-transformers or embeddings API
    k_vec  = emb.encode(req.key.text)
    ev_vec = emb.encode(" ".join(req.key.evidence)) if req.key.evidence else k_vec
    c_vecs = emb.encode_many([c.text for c in req.candidates])
    bank   = load_misconception_bank()                     # [{label, error_type, vec}]

    judge  = dspy.Predict(EntailmentJudge)
    tagger = dspy.Predict(MisconceptionTagger)             # use when author error_type is absent

    scores = []
    for i, c in enumerate(req.candidates):
        ent = judge(evidence=" ".join(req.key.evidence), statement=c.text)
        m   = nearest(bank, c_vecs[i])                     # cosine → (label, error_type, sim)
        pla = clamp01(0.45*cos(c_vecs[i], k_vec) + 0.25*cos(c_vecs[i], ev_vec)
                      + 0.2*m.sim + ERROR_TYPE_PRIOR.get(m.error_type, 0.0))
        near_key = cos(c_vecs[i], k_vec)
        scores.append(DistractorScore(
            id=c.id, plausibility=round(pla, 2),
            error_type=c.error_type or m.error_type,
            misconception=m.label, misconception_similarity=round(m.sim, 2),
            entailed_by_evidence=(ent.verdict == "entailed"), entailment_confidence=ent.confidence,
            too_similar_to_key=(near_key > 0.9),
            flags=[f for f, on in [("accidentally-correct", ent.verdict == "entailed"),
                                   ("too-similar-to-key", near_key > 0.9),
                                   ("off-misconception", m.sim < 0.5)] if on]))

    sim = pairwise_cosine(c_vecs)
    valid = [i for i, s in enumerate(scores) if not s.flags]
    lam = req.target.difficulty if req.target.difficulty is not None else 0.7
    chosen = mmr_select(valid, [s.plausibility for s in scores], sim,
                        k=req.target.slots, lam=lam, cover=lambda i: scores[i].error_type)
    return ScoredPool(
        scores=scores,
        recommended=[req.candidates[i].id for i in chosen],
        rejected=[s.id for s in scores if s.flags])


def mmr_select(idxs, plaus, sim, k, lam, cover):
    chosen, seen = [], set()
    pool = list(idxs)
    while pool and len(chosen) < k:
        def mmr(i):
            div = max((sim[i][j] for j in chosen), default=0.0)
            bonus = 0.1 if cover(i) not in seen else 0.0   # error-type coverage
            return lam*plaus[i] - (1-lam)*div + bonus
        i = max(pool, key=mmr)
        chosen.append(i); seen.add(cover(i)); pool.remove(i)
    return chosen
```

```python
# src/api/routes.py (new route)
@router.post("/score-distractors", response_model=ScoreDistractorsResponse)
async def score_distractors(req: ScoreDistractorsRequest) -> ScoreDistractorsResponse:
    try:
        return ScoreDistractorsResponse(success=True, data=await score_distractor_pool(req), error=None)
    except Exception as e:
        logger.error(f"score-distractors failed: {e}", exc_info=True)
        return ScoreDistractorsResponse(success=False, data=None, error=str(e))
```

## How L0175 consumes it

During authoring the Node console calls `/score-distractors` with passage + key + raw
LLM-generated foils, then:
- writes `scores[].plausibility` onto each distractor `claim` (the override attribute already
  in the lexicon),
- uses `error_type` / `misconception` to set/validate the tag (could add an optional
  `misconception` attribute to L0175),
- drops everything in `rejected` (entailed → second correct answer; or redundant),
- optionally pre-prunes to `recommended`.

The emitted `.gc` then compiles **deterministically** — `compose` consumes the baked-in scores.

## Notes & roadmap

- **Embeddings vs LLM split:** cosine does plausibility/distinctness/MMR cheaply; DSPy/LLM does
  the two things vectors can't — the **entailment gate** (accidentally correct?) and
  **misconception naming**.
- **Misconception bank:** small JSON (`label`, `error_type`, `description`), embedded at
  startup, cached; grows from response data.
- **Config:** add `embedding_backend` and `misconception_bank_path` to `src/config.py`;
  cache embeddings by text hash.
- **Longer game (closes the loop):** replace the linear plausibility weights with a regressor
  trained on pilot response data (predicted selection rate + point-biserial) — IRT calibration.
  Retrieval of proven distractors from an item bank (RAG, already in the console pipeline) is a
  parallel track.
