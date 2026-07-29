import { createManagerCoordinator } from "./manager.js";
import { helperValue } from "./helpers/helper.js";

export const createArmoryLifecycle = () => {
  helperValue();
  return createManagerCoordinator();
};
