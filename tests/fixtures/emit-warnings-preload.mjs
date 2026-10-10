// Preload for the warning test: once the entry point has installed its
// DEP0190 filter, emit DEP0190 and an unrelated deprecation.
import process from "node:process";

const original = process.emitWarning;
const timer = setInterval(() => {
  if (process.emitWarning === original) {
    return;
  }
  clearInterval(timer);
  process.emitWarning(
    "Passing args to a child process with shell option true can lead to security vulnerabilities, as the arguments are not escaped, only concatenated.",
    "DeprecationWarning",
    "DEP0190"
  );
  process.emitWarning("An unrelated deprecation.", "DeprecationWarning", "DEP0999");
}, 1);
