/// <reference types="directive-dep" />
// The entry point, and every import clause shape whose erasure the two
// pipelines each decide for themselves.

import { type Options, run } from 'mixed-dep';
import { load } from 'runtime-dep';
import type { Config } from 'type-dep';
import { type Shape, value } from 'value-in-braces-dep';
import 'side-effect-dep';
import * as star from 'star-dep';
import { forwarded } from './forwards';
import { parse } from './grammar';
import { lazily } from './lazy';

// `require.resolve` names a package without loading it — the shape a tool
// config uses to point at a parser.
export const parserPath: string = require.resolve('resolved-dep');

declare const config: Config;
declare const options: Options;
declare const shape: Shape;

export const boot = async (): Promise<string> =>
  `${load()}${run()}${value}${star.all}${await lazily()}${forwarded}${config.name}${options.deep}${shape.x}${parse()}`;
