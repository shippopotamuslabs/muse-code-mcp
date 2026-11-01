export interface QuestionView {
  id: string;
  options?: { label: string }[];
  selection?: { mode?: string };
}

export interface WireAnswer {
  questionId: string;
  selectedLabel?: string;
  selectedLabels?: string[];
  freeText?: string;
  note?: string;
}

/** Map a muse_answer value onto userInput/answer.answers. Free text is sliced to the host's 500-character limit. */
export function buildUserInputAnswers(questions: readonly QuestionView[], answer: unknown): WireAnswer[] {
  if (Array.isArray(answer)) return answer.map(asWireAnswer);
  if (isRecord(answer)) {
    if (Array.isArray(answer.answers)) return answer.answers.map(asWireAnswer);
    return Object.entries(answer).map(([questionId, value]) => oneAnswer(questionFor(questions, questionId), questionId, value));
  }
  if (questions.length === 1) {
    const question = questions[0];
    if (!question) throw new Error("user-input has no questions");
    return [oneAnswer(question, question.id, answer)];
  }
  if (typeof answer === "string") {
    const parsed = tryJson(answer);
    if (parsed !== undefined) return buildUserInputAnswers(questions, parsed);
  }
  throw new Error("answer must be a string for one question, or an object of questionId to answer");
}

function oneAnswer(question: QuestionView | undefined, questionId: string, value: unknown): WireAnswer {
  const text = typeof value === "string" ? value : value === undefined || value === null ? "" : JSON.stringify(value);
  const labels = question?.options?.map((option) => option.label) ?? [];
  if (question?.selection?.mode === "multiple") {
    const picked = text.split(",").map((part) => part.trim()).filter((part) => labels.includes(part));
    if (picked.length > 0) return { questionId, selectedLabels: picked };
  }
  if (labels.includes(text)) return { questionId, selectedLabel: text };
  return { questionId, freeText: text.slice(0, 500) };
}

function questionFor(questions: readonly QuestionView[], id: string): QuestionView | undefined {
  return questions.find((question) => question.id === id);
}

function asWireAnswer(value: unknown): WireAnswer {
  if (!isRecord(value) || typeof value.questionId !== "string") {
    throw new Error("each answer needs a questionId");
  }
  const answer: WireAnswer = { questionId: value.questionId };
  if (typeof value.selectedLabel === "string") answer.selectedLabel = value.selectedLabel;
  if (Array.isArray(value.selectedLabels)) answer.selectedLabels = value.selectedLabels.map(String);
  if (typeof value.freeText === "string") answer.freeText = value.freeText.slice(0, 500);
  if (typeof value.note === "string") answer.note = value.note.slice(0, 500);
  return answer;
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
