export class BaseEvent {
  timestamp = 0;
}

export class ClickEvent extends BaseEvent {
  button = 0;
}

export const wire = JSON.stringify(new ClickEvent());
