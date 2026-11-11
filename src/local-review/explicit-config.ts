import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { ConfigLoader } from '../config/loader';
import { ReviewConfigSchema } from '../config/schema';
import type { ReviewConfig } from '../types';

/** Strict explicit CLI-only config, reusing the regular validated config pipeline. */
export class ExplicitLocalConfigLoader extends ConfigLoader {
  static loadFromPath(filePath: string): ReviewConfig {
    const raw = fs.readFileSync(path.resolve(process.cwd(), filePath), 'utf8');
    const parsed = yaml.load(raw) as Record<string, unknown>;
    const validated = ReviewConfigSchema.parse(parsed);
    return this.resolve(this.normalizeKeys(validated), this.loadFromEnv());
  }
}
