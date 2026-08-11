export class Payload {
  a = 1;
  b = 2;
}

export const json = JSON.stringify(new Payload());
