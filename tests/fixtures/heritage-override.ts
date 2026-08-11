export interface BaseItem {
  id: string;
  name: string;
}

export interface BaseList {
  items: BaseItem[];
}

// DerivedItem must stay assignable to BaseItem through the `items` override
// below, so `id` and `name` are load-bearing even with zero direct references.
export interface DerivedItem {
  id: string;
  name: string;
  deadExtra?: number;
}

export interface DerivedList extends BaseList {
  items: DerivedItem[];
}

export function render(list: BaseList): string {
  return list.items.map(item => `${item.id}:${item.name}`).join(',');
}

export function firstItem(list: DerivedList): DerivedItem {
  return list.items[0];
}
