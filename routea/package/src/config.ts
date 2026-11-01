// Build/install-time configuration for @wbic16/phext (Route A).
//
// sqBaseUrl is the ONLY configuration value, and it is not a secret:
// package configuration is compiled into the artifact and inspectable
// (see Submilli's package-configuration contract: "Credentials: use
// secrets"). The SQ key is never configuration — the package reads it
// per call from submilli:secrets, where only the runtime can reach it.
export declare const sqBaseUrl: string;
