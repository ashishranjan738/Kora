import { BasePatternDetector } from "./base-detector.js";

/**
 * Detector for long-running task indicators (progress bars, test results)
 * Tests against the last line for progress indicators
 */
export class LongRunningDetector extends BasePatternDetector {}
