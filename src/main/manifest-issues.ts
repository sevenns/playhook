// How a zod verdict on a manifest is worded for the user — the one place that turns an issue into a
// sentence, shared by the card reader (one line for the error popup) and the Customize validator (one
// line per field). A refine stores a MessageKey; a structural message is already localized via
// z.config in locale.ts; a MISSING required field gets its own wording, because zod's "expected string,
// received undefined" is what the form would otherwise show under an empty row.
import { type z } from 'zod';
import { translateIssueMessage, type Translator } from '../shared/i18n/index';

/** The first issue as `where: what` — the card reader reports one line, not a list. */
export function formatZodError(error: z.ZodError, item: unknown, t: Translator): string {
  const first = error.issues[0];
  if (first === undefined) return t('manifest.invalid');
  const joined = first.path.join('.');
  const where = joined.length > 0 ? joined : '(root)';
  return `${where}: ${issueMessage(first, item, t)}`;
}

/** What one zod issue says to the user; `item` is the parsed input the issue's path points into. */
export function issueMessage(issue: z.core.$ZodIssue, item: unknown, t: Translator): string {
  if (
    issue.code === 'invalid_type' &&
    issue.path.length > 0 &&
    valueAt(item, issue.path) === undefined
  ) {
    return t('manifest.fieldRequired', { field: issue.path.join('.') });
  }
  return translateIssueMessage(issue.message, t);
}

function valueAt(item: unknown, path: readonly PropertyKey[]): unknown {
  let current: unknown = item;
  for (const key of path) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<PropertyKey, unknown>)[key];
  }
  return current;
}
