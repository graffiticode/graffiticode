import { describe, test, expect, afterEach } from "vitest";
import { parser } from "@graffiticode/parser";
import {
  Compiler,
  Checker,
  Transformer,
  Renderer,
  lexicon,
  setSchemaFetcher,
  clearSchemaCache,
} from "@graffiticode/l0000";

function compile(src, data = {}) {
  return new Promise(async (resolve, reject) => {
    const code = await parser.parse(0, src, lexicon);
    const compiler = new Compiler({
      langID: "0",
      version: "v0.0.0",
      Checker,
      Transformer,
      Renderer,
    });
    compiler.compile(code, data, {}, (err, val) => {
      if (err && err.length > 0) {
        reject(err);
      } else {
        resolve(val);
      }
    });
  });
}

describe("Record key semantics", () => {

  describe("Record creation", () => {
    test("{x: 10} with tag key produces {x: 10}", async () => {
      const result = await compile('{x: 10}..');
      expect(result).toEqual({ x: 10 });
    });

    test("{'x': 10} with string key produces {x: 10}", async () => {
      const result = await compile("{\"x\": 10}..");
      expect(result).toEqual({ x: 10 });
    });

    test("{0: 30} with number key produces {0: 30}", async () => {
      const result = await compile('{0: 30}..');
      expect(result).toEqual({ "0": 30 });
    });

    test("empty record {} produces {}", async () => {
      const result = await compile('{}..');
      expect(result).toEqual({});
    });

    test("multi-field record", async () => {
      const result = await compile('{x: 1, y: 2, z: 3}..');
      expect(result).toEqual({ x: 1, y: 2, z: 3 });
    });
  });

  describe("GET lookup with fallback", () => {
    test("get (tag x) {x: 10} = 10 (tag exact match)", async () => {
      const result = await compile('get (tag x) {x: 10}..');
      expect(result).toBe(10);
    });

    test("get 'x' {x: 10} = 10 (string-to-tag fallback)", async () => {
      const result = await compile("get \"x\" {x: 10}..");
      expect(result).toBe(10);
    });

    test("get (tag x) {'x': 10} = 10 (tag-to-string fallback)", async () => {
      const result = await compile("get (tag x) {\"x\": 10}..");
      expect(result).toBe(10);
    });

    test("get 'x' {'x': 10} = 10 (string exact match)", async () => {
      const result = await compile("get \"x\" {\"x\": 10}..");
      expect(result).toBe(10);
    });
  });

  describe("Exact-match precedence", () => {
    test("get (tag x) {x: 2, 'x': 10} = 2 (tag exact, no fallback)", async () => {
      const result = await compile("get (tag x) {x: 2, \"x\": 10}..");
      expect(result).toBe(2);
    });

    test("get 'x' {x: 2, 'x': 10} = 10 (string exact match)", async () => {
      const result = await compile("get \"x\" {x: 2, \"x\": 10}..");
      expect(result).toBe(10);
    });
  });

  describe("No number fallback", () => {
    test("get '0' {0: 1} = undefined (no number-string fallback)", async () => {
      const result = await compile("get \"0\" {0: 1}..");
      expect(result).toBeUndefined();
    });

    test("get 0 {0: 1} = 1 (number exact match)", async () => {
      const result = await compile('get 0 {0: 1}..');
      expect(result).toBe(1);
    });
  });

  describe("SET preserves key kind", () => {
    test("set (tag y) 20 {x: 10} adds tag key", async () => {
      const result = await compile('set (tag y) 20 {x: 10}..');
      expect(result).toEqual({ x: 10, y: 20 });
    });

    test("set 'z' 30 {x: 10} adds string key", async () => {
      const result = await compile("set \"z\" 30 {x: 10}..");
      expect(result).toEqual({ x: 10, z: 30 });
    });
  });

  describe("LENGTH on records", () => {
    test("length {x: 1, y: 2} = 2", async () => {
      const result = await compile('length {x: 1, y: 2}..');
      expect(result).toBe(2);
    });

    test("length {} = 0", async () => {
      const result = await compile('length {}..');
      expect(result).toBe(0);
    });
  });

  describe("EQUIV on records", () => {
    test("equiv {x: 1} {x: 1} = true", async () => {
      const result = await compile('equiv {x: 1} {x: 1}..');
      expect(result).toBe(true);
    });

    test("equiv {x: 1} {x: 2} = false", async () => {
      const result = await compile('equiv {x: 1} {x: 2}..');
      expect(result).toBe(false);
    });

    test("equiv {x: 1} {'x': 1} = false (different key kinds)", async () => {
      const result = await compile("equiv {x: 1} {\"x\": 1}..");
      expect(result).toBe(false);
    });
  });
});

describe("Existing functionality", () => {

  describe("Arithmetic", () => {
    test("add 1 2 = 3", async () => {
      const result = await compile('add 1 2..');
      expect(result).toBe(3);
    });

    test("mul 3 4 = 12", async () => {
      const result = await compile('mul 3 4..');
      expect(result).toBe(12);
    });

    test("sub 10 3 = 7", async () => {
      const result = await compile('sub 10 3..');
      expect(result).toBe(7);
    });

    test("div 10 4 = 2.5", async () => {
      const result = await compile('div 10 4..');
      expect(result).toBe(2.5);
    });
  });

  describe("Strings", () => {
    test("string literal", async () => {
      const result = await compile("\"hello\"..");
      expect(result).toBe("hello");
    });

    test("concat strings", async () => {
      const result = await compile("concat \"hello\" \" world\"..");
      expect(result).toBe("hello world");
    });
  });

  describe("Lists", () => {
    test("list literal", async () => {
      const result = await compile('[1 2 3]..');
      expect(result).toEqual([1, 2, 3]);
    });

    test("hd [1 2 3] = 1", async () => {
      const result = await compile('hd [1 2 3]..');
      expect(result).toBe(1);
    });

    test("tl [1 2 3] = [2, 3]", async () => {
      const result = await compile('tl [1 2 3]..');
      expect(result).toEqual([2, 3]);
    });

    test("length [1 2 3] = 3", async () => {
      const result = await compile('length [1 2 3]..');
      expect(result).toBe(3);
    });

    test("nth 0 [10 20 30] = 10", async () => {
      const result = await compile('nth 0 [10 20 30]..');
      expect(result).toBe(10);
    });

    test("cons 0 [1 2] = [0, 1, 2]", async () => {
      const result = await compile('cons 0 [1 2]..');
      expect(result).toEqual([0, 1, 2]);
    });

    test("map over list", async () => {
      const result = await compile('map (<x: add x 1>) [1 2 3]..');
      expect(result).toEqual([2, 3, 4]);
    });

    test("filter list", async () => {
      const result = await compile('filter (<x: gt x 1>) [1 2 3]..');
      expect(result).toEqual([2, 3]);
    });

    test("reduce list", async () => {
      const result = await compile('reduce (<acc x: add acc x>) 0 [1 2 3]..');
      expect(result).toBe(6);
    });
  });

  describe("Let bindings", () => {
    test("let x = 10.. x..", async () => {
      const result = await compile('let x = 10.. x..');
      expect(result).toBe(10);
    });

    test("let with record", async () => {
      const result = await compile('let r = {x: 1, y: 2}.. get (tag x) r..');
      expect(result).toBe(1);
    });
  });

  describe("Lambdas", () => {
    test("apply lambda", async () => {
      const result = await compile('apply (<x: add x 1>) 10..');
      expect(result).toBe(11);
    });

    // examples.md 62-64: an unapplied lambda is a value, not a body evaluated with its
    // parameters unbound (which failed in `mul`/`add`, or silently yielded "x").
    test.each([
      ["<x: mul 2 x>..", ["x"]],
      ["<x y: add x y>..", ["x", "y"]],
      ["<x y z: add x add y z>..", ["x", "y", "z"]],
      ["<x: x>..", ["x"]],
      ["let f = <x: mul 2 x>.. f..", ["x"]],
      ["let x = 5.. <x: x>..", ["x"]],
      ["(add)..", ["a", "b"]],
    ])("%s is a lambda value", async (src, params) => {
      expect(await compile(src)).toEqual({ lambda: { params } });
    });

    test("a lambda value nested in a record", async () => {
      expect(await compile("{f: <x: x>}..")).toEqual({ f: { lambda: { params: ["x"] } } });
    });

    // Too few args partially evaluates: the result is a lambda over the unbound parameters.
    test.each([
      ["<x y: add x y> 10..", ["y"]],
      ["(<x y: add x y>) 10..", ["y"]],
      ["(<x y z: add x add y z>) 1..", ["y", "z"]],
      ["(add) 1..", ["b"]],
      ["apply (<x y: add x y>) [10]..", ["y"]],
      ["let f = (add) 1.. f..", ["b"]],
    ])("%s is partially evaluated", async (src, params) => {
      expect(await compile(src)).toEqual({ lambda: { params } });
    });

    test.each([
      ["(<x y: add x y>) 10 20..", 30],
      ["(add) 1 2..", 3],
      ["let f = (add) 1.. f 2..", 3],
      ["apply (<x y: add x y>) [10 20]..", 30],
    ])("%s applies fully", async (src, expected) => {
      expect(await compile(src)).toBe(expected);
    });
  });

  describe("Tags", () => {
    test("tag literal", async () => {
      const result = await compile('tag red..');
      expect(result).toEqual({ tag: "red" });
    });

    test("equiv on tags", async () => {
      const result = await compile('equiv (tag red) (tag red)..');
      expect(result).toBe(true);
    });

    test("tag inequality", async () => {
      const result = await compile('equiv (tag red) (tag blue)..');
      expect(result).toBe(false);
    });
  });

  describe("Comparisons", () => {
    test("lt 1 2 = true", async () => {
      const result = await compile('lt 1 2..');
      expect(result).toBe(true);
    });

    test("gt 2 1 = true", async () => {
      const result = await compile('gt 2 1..');
      expect(result).toBe(true);
    });

    test("eq 5 5 = true", async () => {
      const result = await compile('eq 5 5..');
      expect(result).toBe(true);
    });
  });

  describe("Conditionals", () => {
    test("if true then 1 else 2 = 1", async () => {
      const result = await compile('if true then 1 else 2..');
      expect(result).toBe(1);
    });

    test("if false then 1 else 2 = 2", async () => {
      const result = await compile('if false then 1 else 2..');
      expect(result).toBe(2);
    });
  });

  describe("Data", () => {
    test("data with external input", async () => {
      const result = await compile('data {x: 0}..', { x: 42 });
      expect(result).toEqual({ x: 42 });
    });

    test('parser produces DATA(USE(STR)) for data use "0166"', async () => {
      const nodePool = await parser.parse(0, 'data use "0166"..', lexicon);
      const dataNode = Object.values(nodePool).find(
        n => typeof n === "object" && n && n.tag === "DATA"
      );
      expect(dataNode).toBeTruthy();
      const useNode = nodePool[dataNode.elts[0]];
      expect(useNode.tag).toBe("USE");
      const strNode = nodePool[useNode.elts[0]];
      expect(strNode.tag).toBe("STR");
      expect(strNode.elts[0]).toBe("0166");
    });

    describe('use with mocked schema fetcher', () => {
      // The basis USE visitor fetches L<lang>/schema.json at compile time.
      // Tests inject a mock fetcher and clear the in-process cache.
      function mockFetcher(responses) {
        return async (url) => {
          if (url in responses) {
            const body = responses[url];
            if (body === null) {
              return { ok: false, status: 404, json: async () => null };
            }
            return { ok: true, json: async () => body };
          }
          return { ok: false, status: 404, json: async () => null };
        };
      }

      afterEach(() => {
        setSchemaFetcher(typeof fetch === "function" ? fetch : null);
        clearSchemaCache();
      });

      test('successful fetch + conforming upstream passes', async () => {
        const schema = {
          $id: "test-conform",
          type: "object",
          properties: { x: { type: "number" } },
          required: ["x"],
        };
        setSchemaFetcher(mockFetcher({
          "https://api.graffiticode.org/L0166/schema.json": schema,
        }));
        const result = await compile('data use "0166"..', { x: 42 });
        expect(result).toEqual({ x: 42 });
      });

      test('successful fetch + non-conforming upstream fails', async () => {
        const schema = {
          $id: "test-fail",
          type: "object",
          properties: { x: { type: "number" } },
          required: ["x"],
        };
        setSchemaFetcher(mockFetcher({
          "https://api.graffiticode.org/L0166/schema.json": schema,
        }));
        await expect(compile('data use "0166"..', { y: "wrong" }))
          .rejects.toEqual(expect.arrayContaining([
            expect.objectContaining({
              message: expect.stringContaining("upstream data does not match"),
            }),
          ]));
      });

      test('successful fetch + no upstream returns {} (skip validation)', async () => {
        const schema = {
          $id: "test-skip",
          type: "object",
          properties: { x: { type: "number" } },
          required: ["x"],
        };
        setSchemaFetcher(mockFetcher({
          "https://api.graffiticode.org/L0166/schema.json": schema,
        }));
        const result = await compile('data use "0166"..');
        expect(result).toEqual({});
      });

      test('failed schema fetch surfaces as compile error', async () => {
        setSchemaFetcher(mockFetcher({}));  // returns 404 for everything
        await expect(compile('data use "0166"..'))
          .rejects.toEqual(expect.arrayContaining([
            expect.objectContaining({
              message: expect.stringContaining("failed to load L0166/schema.json"),
            }),
          ]));
      });
    });
  });

  describe("DATA envelope unwrapping (backward compat)", () => {
    test("reads the data model from a { data, errors } envelope upstream", async () => {
      const result = await compile("data {}..", { data: { x: 1 }, errors: [] });
      expect(result).toEqual({ x: 1 });
    });

    test("treats a bare (legacy) upstream as the data model", async () => {
      const result = await compile("data {}..", { x: 1 });
      expect(result).toEqual({ x: 1 });
    });

    test("falls back to the argument when upstream is empty", async () => {
      const result = await compile("data {fallback: 1}..", {});
      expect(result).toEqual({ fallback: 1 });
    });

    test("an errored envelope upstream (data: null) falls back to the argument", async () => {
      const result = await compile("data {fallback: 2}..", { data: null, errors: [{ message: "boom" }] });
      expect(result).toEqual({ fallback: 2 });
    });
  });
});

describe("Boolean logic (examples.md 22-26)", () => {
  test.each([
    ["and true false..", false],
    ["or true false..", true],
    ["not true..", false],
    ["and gt 5 3 lt 2 10..", true],
    ["or eq 1 2 lt 1 2..", true],
  ])("%s", async (src, expected) => {
    expect(await compile(src)).toBe(expected);
  });
});

describe("Higher-order built-ins take functions (examples.md 80-84)", () => {
  test.each([
    ["apply (<a b: add a b>) [1 2]..", 3],
    ["apply (<a b: mul a b>) [3 4]..", 12],
    ["reduce (<a b: max a b>) 0 [3 9 2 7]..", 9],
    // A parenthesized built-in is a function value (@graffiticode/parser >= 1.7.1).
    ["apply (add) [1 2]..", 3],
    ["apply (mul) [3 4]..", 12],
    ["reduce (max) 0 [3 9 2 7]..", 9],
    ["reduce (min) 100 [3 9 2 7]..", 2],
  ])("%s", async (src, expected) => {
    expect(await compile(src)).toBe(expected);
  });
});

describe("Parens only group", () => {
  // `(1 2)` means `1 2`: two expressions, whose value is the LAST in source order. The value
  // used to be whichever finished last, and a PAREN takes an extra async hop, so `(1) 2..`
  // returned 1.
  test.each([
    ["1 2..", 2],
    ["(1 2)..", 2],
    ["(1) 2..", 2],
    ["1 (2)..", 2],
    ["(1) (2)..", 2],
    ["((1 2) 3)..", 3],
    ["(1 (2 3))..", 3],
    ["(add 1 2)..", 3],
    ["(add 1 2) 3..", 3],
    ["let a = (1 2).. a..", 2],
    ["(<x y: add x y>) 10 20..", 30],
    ["((add) 1 2)..", 3],
  ])("%s", async (src, expected) => {
    expect(await compile(src)).toBe(expected);
  });
});

describe("Pattern matching", () => {
  // examples.md 85-93 and the aggregate rules: lists match EXACTLY their length, records are
  // OPEN, patterns nest, and a pattern's variables are bound for its clause value only.
  test.each([
    ['case 1 of 1: "one" _: "other" end..', "one"],
    ['case 5 of 0: "zero" 1: "one" _: "many" end..', "many"],
    ["case 5 of x: add x 1 end..", 6],
    ["case [3 4] of [x y]: add x y end..", 7],
    ["case [3 4] of [x y]: max x y end..", 4],
    ['case {name: "Ann" age: "30"} of {name age}: concat name concat " is " age end..', "Ann is 30"],
    ["case {width: 2 height: 3} of {width height}: mul width height end..", 6],
    ['case {first: "Ada" last: "L"} of {first last}: concat first concat " " last end..', "Ada L"],
    ["case [7 8] of []: 0 _: hd [7 8] end..", 7],
    ["case [] of []: 0 _: 1 end..", 0],
    // Exact-length lists: a longer list falls through.
    ["case [3 4 5] of [x y]: add x y _: 0 end..", 0],
    // Open records, nesting, and literals inside aggregates.
    ["case {kind: tag circle r: 2 id: 9} of {kind: tag circle r}: mul r r _: 0 end..", 4],
    ["case {kind: tag square r: 2} of {kind: tag circle r}: mul r r _: 0 end..", 0],
    ["case {p: [1 2]} of {p: [x y]}: add x y end..", 3],
    ["case [0 4] of [0 y]: y _: 0 end..", 4],
    ["case [1 4] of [0 y]: y _: 0 end..", 0],
    ["case {name: 1} of {name age}: 1 _: 0 end..", 0],
    ["case {age: 3} of {age: years}: years end..", 3],
    // A pattern variable shadows an outer binding.
    ["let x = 100.. case 5 of x: x end..", 5],
    ['case true of false: "f" true: "t" end..', "t"],
    ["case tag red of tag blue: 1 tag red: 2 end..", 2],
  ])("%s", async (src, expected) => {
    expect(await compile(src)).toEqual(expected);
  });

  test("no matching clause yields {}", async () => {
    expect(await compile("case 9 of 1: 1 end..")).toEqual({});
  });
});

describe("let destructuring", () => {
  test.each([
    ["let [a b] = [1 2].. add a b..", 3],
    ['let {name} = {name: "A"}.. name..', "A"],
    ['let {name age: years} = {name: "A" age: 3}.. years..', 3],
    ["let [a [b c]] = [1 [2 3]].. add a add b c..", 6],
    ["let {p: [x y]} = {p: [4 5]}.. mul x y..", 20],
    ["let [a _] = [1 2].. a..", 1],
    ["let a = 1.. let [a b] = [5 6].. a..", 5],
    ["let p = [7 8].. let [x y] = p.. y..", 8],
  ])("%s", async (src, expected) => {
    expect(await compile(src)).toEqual(expected);
  });
});

describe("parameter patterns", () => {
  // The parser gives `<[x y]: ...>` a hidden parameter and inlines each variable as a VAL of it.
  test.each([
    ["<[x y]: add x y>[10 20]..", 30],
    ["<[x y] z: add add x y z> [10 20] 30..", 60],
    ["<{a b}: add a b>{a: 1 b: 2}..", 3],
    ['<{name age: years}: years>{name: "A" age: 3}..', 3],
    ["<[[a b] c]: add a add b c>[[1 2] 3]..", 6],
    ["<[_ b]: b>[1 2]..", 2],
    ["apply (<a [b c]: add a add b c>) [1 [2 3]]..", 6],
    ["map (<[k v]: add k v>) [[1 2] [3 4]]..", [3, 7]],
    ['map (<{a}: a>) [{a: 1} {a: 2}]..', [1, 2]],
    ["reduce (<acc [a b]: add acc mul a b>) 0 [[1 2] [3 4]]..", 14],
    // Nested lambdas' hidden parameters must not capture each other.
    ["map (<[a]: map (<[b]: add a b>) [[10] [20]]>) [[1] [2]]..", [[11, 21], [12, 22]]],
  ])("%s", async (src, expected) => {
    expect(await compile(src)).toEqual(expected);
  });
});

describe("map, filter and reduce pass each element as ONE argument", () => {
  // Elements used to be spread across the lambda's parameters (a list element bound its
  // first item), deep-copied through JSON (erasing records), and an empty list never resumed.
  test.each([
    ["map (<x: length x>) [[1 2] [3 4 5]]..", [2, 3]],
    ["map (<p: case p of [a b]: add a b end>) [[1 2] [3 4]]..", [3, 7]],
    ['map (<r: get "a" r>) [{a: 1} {a: 2}]..', [1, 2]],
    ["map (<x: x>) []..", []],
    ["map (<x: map (<y: add x y>) [10 20]>) [1 2]..", [[11, 21], [12, 22]]],
    ["filter (<x: eq (length x) 2>) [[1 2] [3] [4 5]]..", [[1, 2], [4, 5]]],
    ['filter (<r: gt (get "a" r) 1>) [{a: 1} {a: 2}]..', [{ a: 2 }]],
    ["filter (<x: x>) []..", []],
    ['reduce (<acc r: add acc get "a" r>) 0 [{a: 1} {a: 2}]..', 3],
    ["reduce (<a b: add a b>) 5 []..", 5],
  ])("%s", async (src, expected) => {
    expect(await compile(src)).toEqual(expected);
  });
});

describe("str and template interpolation", () => {
  // `str` is display text: a string as itself, a tag as its name; inside a list or record,
  // values render as Graffiticode source.
  test.each([
    ['str "Ann"..', "Ann"],
    ["str 30..", "30"],
    ["str 0.3..", "0.3"],
    ["str true..", "true"],
    ["str null..", "null"],
    ["str tag red..", "red"],
    ['str [1 "a" [2] tag red null true]..', '[1 "a" [2] tag red null true]'],
    ['str {a: 1 "b c": "x" n: {m: [1]}}..', '{a: 1 "b c": "x" n: {m: [1]}}'],
    ["str []..", "[]"],
    ["str {}..", "{}"],
    ["str (<x y: add x y>)..", "<x y>"],
    ['concat "a" (str 1)..', "a1"],
    // Templates apply `str` to each interpolation, and group it so applications fold.
    ["let a = 30.. `age ${a}`..", "age 30"],
    ['let n = "Ann".. let a = 30.. `${n} is ${a}`..', "Ann is 30"],
    ["`a${add 1 2}b`..", "a3b"],
    ["`t ${tag red} ${true}`..", "t red true"],
    ["let l = [1 2].. `l ${l}`..", "l [1 2]"],
    ["`${map (<x: mul 2 x>) [1 2]}`..", "[2 4]"],
    // examples.md 90
    ['let r = {name: "Ann" age: 30}.. case r of {name age}: `${name} is ${age}` end..', "Ann is 30"],
    // String and record literals inside an interpolation (parser >= 1.9.1).
    ['`x${"s"}y`..', "xsy"],
    ['`x${[1 "a"]}y`..', 'x[1 "a"]y'],
    ["`x${{a: 1}}y`..", "x{a: 1}y"],
    ['`x${get "a" {a: 1}}y`..', "x1y"],
    ['`a${`b${"c"}d`}e`..', "abcde"],
    ['`${case 1 of 1: "one" _: "x" end}`..', "one"],
  ])("%s", async (src, expected) => {
    expect(await compile(src)).toEqual(expected);
  });

  test("concat stays strict", async () => {
    await expect(compile('concat "a" 1..')).rejects.toBeDefined();
  });
});

// map/filter/reduce used to hand `forEach` whatever they were given. `get` on a missing
// key returns undefined by design, so `map (fn) (get "items" (data {}))` with nothing
// bound threw a raw JS TypeError out of the visitor and surfaced as a compile error
// carrying a stack trace.
describe("List builtins on a non-list", () => {
  test.each([
    ['map (<x: mul 2 x>) (get "items" (data {}))..', "map"],
    ['filter (<x: gt x 1>) (get "items" (data {}))..', "filter"],
    ['reduce (<a b: add a b>) 0 (get "items" (data {}))..', "reduce"],
  ])("%s reports a compile error", async (src, fn) => {
    await expect(compile(src)).rejects.toMatchObject([
      { message: expect.stringContaining(`${fn}: expected a list, got undefined`) },
    ]);
  });

  test("names the type it got", async () => {
    await expect(compile("map (<x: x>) 42..")).rejects.toMatchObject([
      { message: "map: expected a list, got a number" },
    ]);
  });

  test("an upstream binding still maps", async () => {
    const result = await compile('map (<x: mul 2 x>) (get "items" (data {}))..', { items: [1, 2, 3] });
    expect(result).toEqual([2, 4, 6]);
  });
});
