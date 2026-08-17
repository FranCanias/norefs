// norefs-ignore: the fixture proves a marked line is suppressed in both pipelines
import { alsoMissing } from 'ignored-unlisted-dep';
import { missing } from 'unlisted-dep';

export const both = (): string => missing + alsoMissing;
