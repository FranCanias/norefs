// The entry point, and every import clause shape whose erasure the two
// pipelines each decide for themselves.

import { type Options, run } from 'mixed-dep';
import { load } from 'runtime-dep';
import type { Config } from 'type-dep';
import { type Shape, value } from 'value-in-braces-dep';
import 'side-effect-dep';
import * as star from 'star-dep';
import { forwarded } from './forwards';
import { lazily } from './lazy';

declare const config: Config;
declare const options: Options;
declare const shape: Shape;

export const boot = async (): Promise<string> =>
  `${load()}${run()}${value}${star.all}${await lazily()}${forwarded}${config.name}${options.deep}${shape.x}`;
