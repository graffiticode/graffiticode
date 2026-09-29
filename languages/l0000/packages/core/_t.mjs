import { parser } from "@graffiticode/parser";
import { Compiler, Checker, Transformer, Renderer, lexicon } from "@graffiticode/l0000";
for (const src of process.argv.slice(2)) {
  try {
    const code = await parser.parse(0, src, lexicon);
    const r = await new Promise(res => new Compiler({ langID: "0", version: "v0", Checker, Transformer, Renderer }).compile(code, {}, {}, (e, v) => res({ e, v })));
    console.log(JSON.stringify(src), "=>", JSON.stringify(r)?.slice(0, 300));
  } catch (e) { console.log(JSON.stringify(src), "THROW", e?.stack?.split("\n").slice(0,4).join(" | ")); }
}
