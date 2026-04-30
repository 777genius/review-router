import * as fs from 'fs';

type InputOptions = {
  required?: boolean;
};

type CommandProperties = Record<string, string | number | boolean>;

export function getInput(name: string, options: InputOptions = {}): string {
  const envName = `INPUT_${name.replace(/ /g, '_').toUpperCase()}`;
  const value = process.env[envName] || '';

  if (options.required && !value) {
    throw new Error(`Input required and not supplied: ${name}`);
  }

  return value.trim();
}

export function setOutput(name: string, value: unknown): void {
  const output = toCommandValue(value);
  const outputPath = process.env.GITHUB_OUTPUT;

  if (outputPath) {
    const delimiter = `mpr_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    fs.appendFileSync(outputPath, `${name}<<${delimiter}\n${output}\n${delimiter}\n`, 'utf8');
    return;
  }

  issueCommand('set-output', { name }, output);
}

export function setFailed(message: string | Error): void {
  error(message);
  process.exitCode = 1;
}

export function info(message: string): void {
  console.log(message);
}

export function debug(message: string): void {
  issueCommand('debug', {}, message);
}

export function warning(message: string | Error): void {
  issueCommand('warning', {}, message);
}

export function error(message: string | Error): void {
  issueCommand('error', {}, message);
}

function issueCommand(command: string, properties: CommandProperties, message: string | Error): void {
  const propertyText = Object.entries(properties)
    .map(([key, value]) => `${key}=${escapeProperty(String(value))}`)
    .join(',');
  const separator = propertyText ? ` ${propertyText}` : '';

  console.log(`::${command}${separator}::${escapeData(toCommandValue(message))}`);
}

function toCommandValue(value: unknown): string {
  if (value instanceof Error) {
    return value.message;
  }

  if (value === null || value === undefined) {
    return '';
  }

  return String(value);
}

function escapeData(value: string): string {
  return value
    .replace(/%/g, '%25')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A');
}

function escapeProperty(value: string): string {
  return escapeData(value)
    .replace(/:/g, '%3A')
    .replace(/,/g, '%2C');
}
