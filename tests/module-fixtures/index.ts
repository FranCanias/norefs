import './registered';
import { chainFn } from './barrel';
import { box } from './box';
import type { UsedShape } from './exports';
import { usedFn } from './exports';
import * as helpers from './helpers';
import { serve, serveLater } from './lazy-user';
import { Config } from './ns-decl';
import * as recipes from './recipes';

export function run(v: UsedShape): number {
  helpers.one();
  chainFn();
  void serve();
  void serveLater();
  return usedFn() + v.width + Config.used + box(recipes);
}
