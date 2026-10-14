export function parseArgs(argv, config = {}) {
  const valueOptions = new Set(config.valueOptions ?? []);
  const booleanOptions = new Set(config.booleanOptions ?? []);
  const aliasMap = config.aliasMap ?? {};
  const options = {};
  const positionals = [];
  let passthrough = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (passthrough) {
      positionals.push(token);
      continue;
    }

    if (token === "--") {
      passthrough = true;
      continue;
    }

    if (!token.startsWith("-") || token === "-") {
      positionals.push(token);
      continue;
    }

    if (token.startsWith("--")) {
      // Split at the first "=" only, so values may contain "=" themselves.
      const body = token.slice(2);
      const separator = body.indexOf("=");
      const rawKey = separator === -1 ? body : body.slice(0, separator);
      const inlineValue = separator === -1 ? undefined : body.slice(separator + 1);
      const key = aliasMap[rawKey] ?? rawKey;

      if (booleanOptions.has(key)) {
        options[key] = inlineValue === undefined ? true : inlineValue !== "false";
        continue;
      }

      if (valueOptions.has(key)) {
        const nextValue = inlineValue ?? argv[index + 1];
        if (nextValue === undefined) {
          throw new Error(`Missing value for --${rawKey}`);
        }
        options[key] = nextValue;
        if (inlineValue === undefined) {
          index += 1;
        }
        continue;
      }

      positionals.push(token);
      continue;
    }

    const shortKey = token.slice(1);
    const key = aliasMap[shortKey] ?? shortKey;

    if (booleanOptions.has(key)) {
      options[key] = true;
      continue;
    }

    if (valueOptions.has(key)) {
      const nextValue = argv[index + 1];
      if (nextValue === undefined) {
        throw new Error(`Missing value for -${shortKey}`);
      }
      options[key] = nextValue;
      index += 1;
      continue;
    }

    positionals.push(token);
  }

  return { options, positionals };
}

const QUOTES = new Set(["'", "\""]);
// Inside the raw string a backslash only escapes these; elsewhere it stays, so text such as a
// regex (\d+) or a Windows path keeps its backslashes.
const ESCAPABLE = new Set(["'", "\"", "\\", " ", "\t"]);

/**
 * Splits a slash command's raw argument string into tokens. Quotes group words only when they
 * open a token (or follow "=") and have a matching closing quote, so apostrophes in ordinary
 * text, such as "the user's bug", stay literal instead of swallowing the rest of the line.
 */
export function splitRawArgumentString(raw) {
  const text = String(raw ?? "");
  const tokens = [];
  let current = "";
  let started = false;

  const finish = () => {
    if (started) {
      tokens.push(current);
    }
    current = "";
    started = false;
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (character === "\\" && index + 1 < text.length && ESCAPABLE.has(text[index + 1])) {
      current += text[index + 1];
      started = true;
      index += 1;
      continue;
    }

    const opensQuote = QUOTES.has(character) && (!started || current.endsWith("="));
    if (opensQuote) {
      const closing = text.indexOf(character, index + 1);
      if (closing !== -1) {
        current += text.slice(index + 1, closing);
        started = true;
        index = closing;
        continue;
      }
    }

    if (/\s/.test(character)) {
      finish();
      continue;
    }

    current += character;
    started = true;
  }

  finish();
  return tokens;
}
