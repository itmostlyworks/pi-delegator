/** Private child marker and exit codes shared without importing Pi runtime modules. */
export const DELEGATE_CHILD_ENV = "PI_DELEGATOR_CHILD";
export const DELEGATE_CHILD_ENV_VALUE = "1";

// Keep these outside the conventional shell signal range (128-255).
export const DELEGATE_BASH_TIMEOUT_EXIT_CODE = 86;
export const DELEGATE_BASH_ABORT_EXIT_CODE = 87;
