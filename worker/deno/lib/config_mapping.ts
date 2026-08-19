/**
 * Configuration key mapping utility (Issue #630).
 *
 * Provides a tested utility function for converting snake_case
 * configuration keys to camelCase TypeScript property names.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

/**
 * Convert a snake_case string to camelCase.
 *
 * Examples:
 *   mapSnakeToCamel("allowed_author") => "allowedAuthor"
 *   mapSnakeToCamel("max_clarification_rounds") => "maxClarificationRounds"
 *   mapSnakeToCamel("repos") => "repos"
 *   mapSnakeToCamel("") => ""
 *
 * @param snakeCase - The snake_case string to convert
 * @returns The camelCase equivalent
 */
export function mapSnakeToCamel(snakeCase: string): string {
  if (!snakeCase) return "";

  return snakeCase
    .split("_")
    .filter((part) => part.length > 0)
    .map((part, index) => {
      if (index === 0) return part;
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join("");
}
