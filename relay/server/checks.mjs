const CONTROL_CHARACTERS = /\p{Cc}/gu;

export function check(condition, message) {
  if (!condition) throw new Error(message);
}

export const isOptionalTab = (tab) => tab === undefined || tab === null || Number.isInteger(tab);

export const cleanLine = (text, maxLength) => text.replace(CONTROL_CHARACTERS, ' ').trim().slice(0, maxLength);
