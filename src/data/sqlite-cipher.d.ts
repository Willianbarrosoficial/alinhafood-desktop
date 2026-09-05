// Tipos do driver com cifra. `better-sqlite3-multiple-ciphers` é um fork 1:1 do
// better-sqlite3 (mesma API, mesmo número de versão) que embute o SQLite3
// Multiple Ciphers; ele não publica .d.ts próprios, e o @types/better-sqlite3
// continua servindo. Este arquivo só liga um nome ao outro.
declare module 'better-sqlite3-multiple-ciphers' {
  import Database from 'better-sqlite3';
  export = Database;
}
