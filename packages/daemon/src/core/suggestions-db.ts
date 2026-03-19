/**
 * SuggestionsDatabase — stub for integration tests.
 * TODO: Implement actual suggestions tracking for recent paths and flags.
 */

export class SuggestionsDatabase {
  constructor() {
    // Stub constructor
  }

  // Stub methods - to be implemented
  recordPath(_path: string): void {
    // No-op stub
  }

  recordFlags(_flags: string): void {
    // No-op stub
  }

  async getRecentPaths(): Promise<string[]> {
    return [];
  }

  async getRecentFlags(): Promise<string[]> {
    return [];
  }
}
