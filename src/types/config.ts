export interface ProtonMailBridgeConfig {
  host:     string;
  imapPort: number;
  username: string;
  password: string;
  tls: {
    rejectUnauthorized: boolean;
  };
}

export interface ConnectionPoolConfig {
  min: number;
  max: number;
}

export interface McpHttpConfig {
  host:      string;
  port:      number;
  basePath:  string;
  authToken: string;
}

export interface LogConfig {
  logPath?:     string;  // undefined → stderr
  auditLogPath: string;  // required; file only, never stderr
  logLevel:     string;
}

export interface AppConfig {
  bridge:  ProtonMailBridgeConfig;
  pool:    ConnectionPoolConfig;
  http:    McpHttpConfig;
  log:     LogConfig;
  verify:  boolean;
}
