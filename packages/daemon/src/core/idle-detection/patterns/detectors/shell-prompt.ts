import { BasePatternDetector } from "./base-detector.js";

/**
 * Detector for shell prompt patterns (idle state)
 * Tests against the last line of terminal output
 */
export class ShellPromptDetector extends BasePatternDetector {}
