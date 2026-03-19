import { BasePatternDetector } from "./base-detector.js";

/**
 * Detector for interactive prompt patterns (y/n, passwords, menus)
 * Tests against the last line for interactive prompts
 */
export class InteractiveDetector extends BasePatternDetector {}
