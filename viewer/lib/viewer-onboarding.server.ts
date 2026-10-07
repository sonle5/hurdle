import "server-only";
import { readViewerEnvironment } from "./viewer-environment.mjs";
import { validateViewerOnboarding } from "../../harness/lib/viewer-onboarding.mjs";

export function getViewerOnboarding() {
  const context = readViewerEnvironment(process.env, "HURDLE_VIEWER_ONBOARDING");
  if (!context) return null;
  try {
    return validateViewerOnboarding(JSON.parse(context));
  } catch {
    return null;
  }
}
