import { greet } from '@acme/b';
import { exclaim } from '~/exclaim';

export function main(): string {
  return exclaim(greet());
}
