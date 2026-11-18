# PostgreSQL MCP y fallback local

V1 publica sólo `execute_sql` y `search_objects` para PostgreSQL. Ambas rutas usan el
mismo catálogo y el mismo JSON canónico: el servidor MCP devuelve ese JSON en
`content[0].text`, y el CLI lo imprime directamente, sin el envelope general.

```sh
aw tool list --connection my-connection
aw tool call execute_sql --connection my-connection --input-json '{"sql":"SELECT 1"}'
printf '%s' '{"object_type":"table","pattern":"user%"}' \
  | aw tool call search_objects --connection my-connection --input-json -
```

`execute_sql` acepta una sola sentencia de lectura y ejecuta cada llamada en una conexión
nueva, transacción `READ ONLY`, timeout de 30 s y rollback final. El resultado se limita a
1.000 filas y 4 MiB; la entrada JSON se limita a 1 MiB. Nunca pongas un DSN, SQL ni resultados
en los archivos de host, recibos u logs operativos.

`search_objects` conserva el envelope de DBHub 1.2.1: `object_type`, `pattern`, filtros
opcionales, `detail_level`, `count`, `results` y `truncated`. Sus siete tipos y tres niveles
mantienen los campos de descubrimiento de DBHub; `truncated` sólo vale `true` cuando se observó
una fila adicional que quedó fuera del límite.

`READ ONLY` no reemplaza una cuenta PostgreSQL de mínimo privilegio: no uses superuser, permisos
de escritura/creación, ni membresía o vía `SET ROLE` hacia `pg_signal_backend`,
`pg_signal_autovacuum_worker`, `pg_read_server_files`, `pg_write_server_files` o
`pg_execute_server_program`. Con superuser o esos roles de servidor, el ejecutor avisa con `DATABASE_ROLE_UNSAFE`
y la lectura sigue dentro de `READ ONLY`; con
`aw mcp doctor --probe data`, los demás privilegios de escritura se informan como advertencia y la
conexión no queda marcada como segura. Tampoco concedas `EXECUTE` sobre extensiones o funciones con
efectos externos.

`aw mcp serve-db --instance <nombre>` es el servidor stdio; `aw mcp dbhub` sigue durante una
versión como alias deprecado. `aw mcp doctor --probe launch` comprueba `initialize → initialized
→ tools/list`; `--probe data` añade `SELECT 1 AS ok`. `aw mcp migrate` sólo muestra preview;
escribir requiere `--apply --force` y no se ejecuta automáticamente.
