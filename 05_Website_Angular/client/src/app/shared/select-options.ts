/** Options for the spartan Select, declared once and used twice.
 *
 *  The control stores a plain string value, so its trigger would otherwise
 *  display the raw code — "open" instead of "Open and accepting". It takes an
 *  itemToString to resolve that, which means the label exists in two places
 *  unless the list itself is the single source. Declaring the options here and
 *  rendering the items with @for keeps the label written once, so a wording
 *  change cannot leave the trigger saying something the list does not.
 */
export interface SelectOption<T extends string = string> {
  readonly v: T;
  readonly label: string;
}

/** Builds the itemToString for a list of options. */
export function labelFor<T extends string>(
  options: readonly SelectOption<T>[],
): (value: T) => string {
  return (value) => options.find((o) => o.v === value)?.label ?? String(value ?? '');
}
