// Pretty printer that converts an AST back to source code
import { lexicon as basisLexicon } from "@graffiticode/basis";

/**
 * Unparse an AST node to source code
 * @param {object} node - The AST node to unparse
 * @param {object} lexicon - The lexicon containing operator and keyword definitions
 * @returns {string} The unparsed source code
 */
function unparseNode(node, lexicon) {
  if (!node) {
    return "";
  }

  // Handle primitive values
  if (typeof node === "string" || typeof node === "number" || typeof node === "boolean") {
    return String(node);
  }

  // Handle AST nodes
  switch (node.tag) {
    case "PROG":
      // Program is a list of expressions ending with ".."
      if (node.elts && node.elts.length > 0) {
        const exprs = unparseNode(node.elts[0], lexicon);
        return exprs + "..";
      }
      return "..";

    case "EXPRS":
      // Multiple expressions separated by periods
      if (!node.elts || node.elts.length === 0) {
        return "";
      }
      // Check if this looks like a function application that wasn't folded
      // e.g., sub followed by arguments as separate expressions
      if (node.elts.length >= 3) {
        const first = node.elts[0];
        // Check if first element is an identifier that could be a function
        if (first && first.tag && first.elts && first.elts.length === 0) {
          // This might be a function name followed by arguments
          const funcName = first.tag;
          // Check if this matches a lexicon function
          if (lexicon && lexicon[funcName]) {
            const arity = lexicon[funcName].arity || 0;
            if (arity > 0 && node.elts.length === arity + 1) {
              // Treat this as a function application
              const args = node.elts.slice(1).map(elt => unparseNode(elt, lexicon)).join(" ");
              return `${funcName} ${args}`;
            }
          }
        }
      }
      return node.elts.map(elt => unparseNode(elt, lexicon)).join(".");

    case "NUM":
      return node.elts[0];

    case "STR": {
      // Escape quotes and backslashes in the string
      const str = node.elts[0];
      const escaped = str.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
      return `'${escaped}'`;
    }

    case "BOOL":
      return node.elts[0] ? "true" : "false";

    case "NULL":
      return "null";

    case "IDENT":
      return node.elts[0];

    case "LIST": {
      // Array literal [a, b, c]
      if (!node.elts || node.elts.length === 0) {
        return "[]";
      }
      const items = node.elts.map(elt => unparseNode(elt, lexicon));
      return "[" + items.join(", ") + "]";
    }

    case "RECORD": {
      // Object literal {a: 1, b: 2}
      if (!node.elts || node.elts.length === 0) {
        return "{}";
      }
      const bindings = node.elts.map(elt => unparseNode(elt, lexicon));
      return "{" + bindings.join(", ") + "}";
    }

    case "BINDING": {
      // Key-value pair in a record
      if (node.elts && node.elts.length >= 2) {
        // If the key is a string node, unparse it without quotes for object keys
        let key;
        if (node.elts[0] && node.elts[0].tag === "STR") {
          key = node.elts[0].elts[0]; // Get the raw string without quotes
        } else {
          key = unparseNode(node.elts[0], lexicon);
        }
        const value = unparseNode(node.elts[1], lexicon);
        return `${key}: ${value}`;
      }
      return "";
    }

    case "PAREN":
      // Parenthesized expression
      if (node.elts && node.elts.length > 0) {
        return "(" + unparseNode(node.elts[0], lexicon) + ")";
      }
      return "()";

    case "APPLY":
      // Function application
      if (node.elts && node.elts.length >= 2) {
        const func = unparseNode(node.elts[0], lexicon);
        const args = unparseNode(node.elts[1], lexicon);
        return func + " " + args;
      }
      return "";

    case "LAMBDA":
      // Lambda function
      if (node.elts && node.elts.length >= 3) {
        const params = node.elts[1];
        const body = node.elts[2];

        // Extract parameter names
        let paramStr = "";
        if (params && params.elts) {
          paramStr = params.elts.map(p => unparseNode(p, lexicon)).join(" ");
        }

        // Unparse body
        const bodyStr = unparseNode(body, lexicon);

        if (paramStr) {
          return `\\${paramStr} . ${bodyStr}`;
        } else {
          return `\\. ${bodyStr}`;
        }
      }
      return "";

    case "LET":
      // Let binding
      if (node.elts && node.elts.length >= 2) {
        const bindings = node.elts[0];
        const body = node.elts[1];

        let bindingStr = "";
        if (bindings && bindings.elts) {
          bindingStr = bindings.elts.map(b => {
            if (b.elts && b.elts.length >= 2) {
              const name = unparseNode(b.elts[0], lexicon);
              const value = unparseNode(b.elts[1], lexicon);
              return `${name} = ${value}`;
            }
            return "";
          }).filter(s => s).join(", ");
        }

        const bodyStr = unparseNode(body, lexicon);
        return `let ${bindingStr} in ${bodyStr}`;
      }
      return "";

    case "IF":
      // If-then-else
      if (node.elts && node.elts.length >= 2) {
        const cond = unparseNode(node.elts[0], lexicon);
        const thenExpr = unparseNode(node.elts[1], lexicon);

        if (node.elts.length >= 3) {
          const elseExpr = unparseNode(node.elts[2], lexicon);
          return `if ${cond} then ${thenExpr} else ${elseExpr}`;
        } else {
          return `if ${cond} then ${thenExpr}`;
        }
      }
      return "";

    case "CASE":
      // Case expression
      if (node.elts && node.elts.length > 0) {
        const expr = unparseNode(node.elts[0], lexicon);
        const cases = node.elts.slice(1).map(c => unparseNode(c, lexicon));
        return `case ${expr} of ${cases.join(" | ")}`;
      }
      return "";

    case "OF":
      // Case branch
      if (node.elts && node.elts.length >= 2) {
        const pattern = unparseNode(node.elts[0], lexicon);
        const expr = unparseNode(node.elts[1], lexicon);
        return `${pattern} => ${expr}`;
      }
      return "";

    // Unary operator - negative
    case "NEG":
      if (node.elts && node.elts.length >= 1) {
        const expr = unparseNode(node.elts[0], lexicon);
        return `-${expr}`;
      }
      return "";

    case "ERROR":
      // Error nodes - include as comments
      if (node.elts && node.elts.length > 0) {
        return `/* ERROR: ${node.elts[0]} */`;
      }
      return "/* ERROR */";

    default: {
      // Check if this is a lexicon-defined function
      // First, find the source name for this tag in the lexicon
      let sourceName = null;
      if (lexicon) {
        for (const [key, value] of Object.entries(lexicon)) {
          if (value && value.name === node.tag) {
            sourceName = key;
            break;
          }
        }
      }

      if (sourceName) {
        // This is a known lexicon function - unparse in prefix notation
        if (node.elts && node.elts.length > 0) {
          const args = node.elts.map(elt => unparseNode(elt, lexicon)).join(" ");
          return `${sourceName} ${args}`;
        }
        return sourceName;
      }

      // Handle identifiers that aren't in the lexicon (like lowercase "sub")
      if (node.elts && node.elts.length === 0) {
        // This is likely an identifier
        return node.tag;
      }

      // Fallback for unknown nodes
      console.warn(`Unknown node tag: ${node.tag}`);
      return `/* ${node.tag} */`;
    }
  }
}

/**
 * Unparse an AST pool (as returned by the parser) to source code
 * @param {object} ast - The AST pool with a root property
 * @param {object} dialectLexicon - The dialect-specific lexicon (optional)
 * @returns {string} The unparsed source code
 */
export function unparse(ast, dialectLexicon = {}) {
  if (!ast || !ast.root) {
    return "";
  }

  // Merge basis lexicon with dialect lexicon (dialect takes precedence)
  const mergedLexicon = { ...basisLexicon, ...dialectLexicon };

  // The AST is in pool format - reconstruct the tree from the root
  const rootId = ast.root;
  const rootNode = reconstructNode(ast, rootId);

  return unparseNode(rootNode, mergedLexicon);
}

/**
 * Reconstruct a node from the AST pool format
 * @param {object} pool - The AST pool
 * @param {string|number} nodeId - The node ID to reconstruct
 * @returns {object} The reconstructed node
 */
function reconstructNode(pool, nodeId) {
  if (!nodeId || nodeId === "0" || nodeId === 0) {
    return null;
  }

  const node = pool[nodeId];
  if (!node) {
    return null;
  }

  // Create a new node with the same structure
  const result = {
    tag: node.tag,
    elts: []
  };

  // Handle different node types
  switch (node.tag) {
    case "NUM":
    case "STR":
    case "IDENT":
    case "BOOL":
      // These nodes have primitive values in elts[0]
      result.elts = [node.elts[0]];
      break;

    case "NULL":
      // NULL nodes have no elements
      result.elts = [];
      break;

    default:
      // For all other nodes, recursively reconstruct child nodes
      if (node.elts && Array.isArray(node.elts)) {
        result.elts = node.elts.map(eltId => {
          // Check if this is a node ID (number or string number)
          if (typeof eltId === "number" || (typeof eltId === "string" && /^\d+$/.test(eltId))) {
            // This is a reference to another node in the pool
            return reconstructNode(pool, eltId);
          } else {
            // This is a primitive value
            return eltId;
          }
        });
      }
      break;
  }

  return result;
}
