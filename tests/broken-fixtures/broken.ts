import { value } from 'declared-elsewhere';
import { gone } from 'not-installed-package';
import { missing } from './does-not-exist';
import type { Resolvable } from './resolved';
import styles from './theme.css';
import './side-effect-only';

export function use(v: Resolvable): unknown {
  return [v.ok, missing, gone, styles, value];
}
