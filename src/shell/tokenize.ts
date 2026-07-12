export function tokenizeShellLine(line: string): readonly string[] {
  const tokens: string[] = [];
  let value = "";
  let quote: "'" | '"' | undefined;
  let escaping = false;
  let started = false;

  const finish = () => {
    if (!started) return;
    tokens.push(value);
    value = "";
    started = false;
  };

  for (const character of line) {
    if (escaping) {
      value += character;
      escaping = false;
      started = true;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaping = true;
      started = true;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = undefined;
      } else {
        value += character;
      }
      started = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      started = true;
    } else if (/\s/u.test(character)) {
      finish();
    } else {
      value += character;
      started = true;
    }
  }

  if (escaping) throw new Error("Command ends with an incomplete escape");
  if (quote) throw new Error("Command contains an unterminated quote");
  finish();
  return tokens;
}
