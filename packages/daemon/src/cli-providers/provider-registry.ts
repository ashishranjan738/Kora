import type { CLIProvider } from "@kora/shared";

export class CLIProviderRegistry {
  private providers = new Map<string, CLIProvider>();

  register(provider: CLIProvider): void {
    this.providers.set(provider.id, provider);
  }

  get(id: string): CLIProvider | undefined {
    return this.providers.get(id);
  }

  list(): CLIProvider[] {
    return Array.from(this.providers.values());
  }

  has(id: string): boolean {
    return this.providers.has(id);
  }
}

/** Singleton registry shared across the daemon */
export const registry = new CLIProviderRegistry();
