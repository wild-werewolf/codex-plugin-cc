/**
 * Silence Node's DEP0190 ("Passing args to a child process with shell option
 * true ...") and nothing else. On Windows the companion spawns `codex` through
 * a shell on purpose (npm installs it as a .cmd shim), so the warning is noise
 * in every command's output. Import this module first in each entry point.
 */
import process from "node:process";

const SUPPRESSED_WARNING_CODES = new Set(["DEP0190"]);

function warningCode(warning, typeOrOptions, code) {
  if (typeOrOptions && typeof typeOrOptions === "object") {
    return typeOrOptions.code ?? null;
  }
  if (typeof code === "string") {
    return code;
  }
  return warning && typeof warning === "object" ? warning.code ?? null : null;
}

if (!process.emitWarning.codexCompanionFiltered) {
  const emitWarning = process.emitWarning;
  const filtered = function (warning, typeOrOptions, code, ...rest) {
    if (SUPPRESSED_WARNING_CODES.has(warningCode(warning, typeOrOptions, code))) {
      return;
    }
    return emitWarning.call(this, warning, typeOrOptions, code, ...rest);
  };
  filtered.codexCompanionFiltered = true;
  process.emitWarning = filtered;
}
