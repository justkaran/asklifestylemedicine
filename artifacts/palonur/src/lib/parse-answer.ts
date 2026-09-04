/**
 * Shared parser for governed /slm answers. The server streams a labeled
 * plain-text format (ANSWER / CITATION / PAPER / FINDING / INTERPRETATION,
 * or a REFUSE:/UNCOVERED: prefix); this turns it into sections for display.
 * Used by the /slm ask page, the answer permalink page, and the home hero
 * example answer.
 */

export interface ParsedAnswer {
  answer: string;
  citation: string;
  paper: string;
  finding: string;
  interpretation: string;
  refused: boolean;
  uncovered: boolean;
  raw: string;
}

export function parseAnswer(text: string): ParsedAnswer {
  const raw = text.trim();
  const refused = raw.startsWith("REFUSE:");
  const uncovered = raw.startsWith("UNCOVERED:");

  function extract(label: string): string {
    const re = new RegExp(`${label}:\\s*([\\s\\S]*?)(?=\\n[A-Z]+:|$)`, "i");
    const m = re.exec(raw);
    return m ? m[1].trim() : "";
  }

  return {
    raw,
    refused,
    uncovered,
    answer: refused
      ? raw.replace(/^REFUSE:\s*/i, "")
      : uncovered
        ? raw.replace(/^UNCOVERED:\s*/i, "")
        : extract("ANSWER"),
    citation: extract("CITATION"),
    paper: extract("PAPER"),
    finding: extract("FINDING"),
    interpretation: extract("INTERPRETATION"),
  };
}
