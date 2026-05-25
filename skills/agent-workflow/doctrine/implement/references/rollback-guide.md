# Guía de Rollback — implement

## Cuándo hacer rollback

Aplicar rollback cuando:
- La compilación falla después de un cambio y la corrección no es obvia.
- Un test que antes pasaba ahora falla por el cambio introducido.
- El usuario solicita revertir un cambio.
- Se detecta que el enfoque tomado no es el correcto.

## Procedimiento

### Rollback de último cambio (más común)

1. Identificar los archivos modificados en el último diff (`git diff HEAD` o histórico de la conversación).
2. Revertir usando git:
   ```bash
   git checkout -- ruta/archivo.java
   ```
3. Si los cambios están staged:
   ```bash
   git restore --staged --worktree ruta/archivo.java
   ```
4. Si no hay git, aplicar el diff inverso manualmente con Edit.
5. Compilar para verificar que el rollback fue exitoso (si aplica).
6. Registrar el rollback en `DECISIONS.md`:
   ```markdown
   ## DEC-NNN: Rollback de [descripción]

   Decisión: revertir el cambio de [archivo(s)] del [fecha].
   Por qué: [motivo: build falla / test rojo / enfoque incorrecto / pedido del usuario].
   Plan alternativo: [próximo intento o decisión de pausar].
   ```

### Rollback de múltiples cambios

1. Identificar el commit estable más reciente.
2. Listar todos los archivos modificados desde ese punto (`git diff <commit>..HEAD --name-only`).
3. Revertir en orden inverso (último cambio primero).
4. Compilar después de cada reversión parcial si el riesgo lo justifica.
5. Documentar todo en `DECISIONS.md` con una sola entrada DEC-NNN explicando el rollback masivo y por qué.

### Rollback con git stash

Si se quiere preservar el trabajo para revisión futura:
```bash
git stash push -m "session00X: rollback de [descripción]"
```

El stash queda disponible para reaplicar (`git stash pop`) o descartar (`git stash drop`) según la decisión posterior del usuario.

## Después del rollback

1. Revisar `TASKS.md`: marcar la tarea como pendiente nuevamente (`[x] → [ ]`).
2. Discutir con el usuario el nuevo enfoque.
3. Documentar en `DECISIONS.md` qué se aprendió (1-2 oraciones).
4. Continuar con la implementación alternativa.

## Prevención

Para minimizar la necesidad de rollback:
- Diffs pequeños e incrementales (1 preocupación por diff).
- Compilar/probar después de cada cambio significativo si el cambio es de alto riesgo.
- Verificar con el usuario antes de cambios estructurales grandes.
- Usar branches de git si el cambio es exploratorio (rama temporal).

## Rollback de BD

Los rollbacks de código (git) descritos arriba **no revierten cambios en base de datos**. Para revertir scripts SQL ejecutados en producción, usar el skill `sql-rollback-generator`.

El skill (v2.0.0+) produce:
- **Un único `00-ROLLBACK.sql`** al root del bundle generado por `/agent-workflow:export-scripts` v4.0.0+. Encadena rollbacks cross-session en orden inverso (última sesión → primera, 04→01 dentro de cada una) dentro de un `BEGIN; ... COMMIT;` único.
- **Bloque "Fase 5 — Cleanup irreversible"** al final del archivo, fuera de la transacción, listando irreversibles para revisión manual.

> Comportamiento v1.0.0 (companions `.rollback.sql` por sentencia + per-sesión `rollback/`) eliminado en v2.0.0. Bundles ya generados con v1.0.0 quedan como histórico.

Para operaciones irreversibles (TRUNCATE, DROP COLUMN, DROP TABLE sin backup), ver `skills/sql-rollback-generator/references/irreversible-checklist.md`.

## Reglas

- **Nunca** ejecutar `git reset --hard`, `git clean -f`, o destructivos similares como atajo. Si dudás, preguntá.
- **Siempre** registrar el rollback en `DECISIONS.md` (el qué Y el por qué).
- **El rollback de código no implica rollback de BD** ni viceversa: se manejan en paralelo si aplica.
