"use strict";
const number = (
  key,
  label,
  value,
  min,
  max,
  step = 1,
  nullable = false,
  stage = "server",
) => ({ key, label, value, min, max, step, nullable, stage, type: "number" });
const rent = (min, max, stage = "query") => [
  number("minRent", "Аренда от, €", min, 0, 20000, 1, false, stage),
  number("maxRent", "Аренда до, €", max, 0, 20000, 1, max === null, stage),
];
const area = number("minArea", "Площадь от, м²", null, 0, 1000, 1, true);
module.exports = { number, rent, area };
