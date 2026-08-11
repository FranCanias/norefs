function register(_target: unknown, _ctx: ClassDecoratorContext): void {}

@register
export class Plugin {
  neverRead = 1;
}

new Plugin();
