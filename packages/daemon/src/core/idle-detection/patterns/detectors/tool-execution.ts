import { BasePatternDetector } from "./base-detector.js";

/**
 * Detector for tool/command execution patterns
 * Tests against the last line for command execution indicators
 */
export class ToolExecutionDetector extends BasePatternDetector {}
