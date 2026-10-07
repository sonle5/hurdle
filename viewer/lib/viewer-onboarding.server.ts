import "server-only";
import { validateViewerOnboarding } from "../../harness/lib/viewer-onboarding.mjs";

export function getViewerOnboarding() {
  const context = process.env.TAE_VIEWER_ONBOARDING;
  if (!context) return null;
  try {
    return validateViewerOnboarding(JSON.parse(context));
  } catch {
    return null;
  }
}
