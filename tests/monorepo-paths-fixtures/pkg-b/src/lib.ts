import { word } from '~/word';

export function greet(): string {
  return word();
}

export function alone(): string {
  return 'alone';
}
