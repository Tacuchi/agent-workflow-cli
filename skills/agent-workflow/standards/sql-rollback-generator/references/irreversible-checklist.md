# Checklist de Operaciones Irreversibles

Operaciones que no pueden revertirse automáticamente. Requieren protocolo especial antes de ejecutar.

---

## Protocolo ante una operación irreversible

Antes de ejecutar cualquier operación de esta lista:

1. **Agregar `-- WARNING: IRREVERSIBLE`** en el header del forward script
2. **Crear script de respaldo** si hay datos en riesgo (ver plantillas en `rollback-patterns.md`)
3. **Registrar en `DECISIONS.md`** de la sesión:
   - Qué se va a ejecutar
   - Por qué no es reversible
   - Qué backup existe (o por qué no aplica)
   - Confirmación explícita del usuario
4. **Generar rollback best-effort** con nota `-- RESTAURACIÓN MANUAL REQUERIDA` si el rollback automático no es posible
5. **Checkpoint**: el usuario debe confirmar explícitamente antes de continuar

---

## Lista de operaciones irreversibles

### TRUNCATE TABLE

```sql
-- WARNING: IRREVERSIBLE
-- Elimina TODOS los datos de la tabla sin posibilidad de rollback transaccional en algunos motores.
-- En PostgreSQL se puede envolver en BEGIN/COMMIT, pero el efecto es inmediato si se confirma.
-- Respaldo obligatorio en esq_audit antes de ejecutar.
```

**Mitigación**: `CREATE TABLE esq_audit.tb_bkp_x_sessionXXX AS SELECT * FROM esq_.tb_x;` antes.

---

### DROP COLUMN sin respaldo previo

```sql
-- WARNING: IRREVERSIBLE
-- La columna y sus datos se pierden permanentemente.
-- Respaldo: ALTER TABLE tb_x ADD COLUMN col_bkp ... + UPDATE SET col_bkp = col_original;
-- o bien: CREATE TABLE esq_audit.tb_bkp_x_col_sessionXXX AS SELECT id, col FROM tb_x;
```

**Mitigación**: copiar los valores a una columna temporal o tabla de backup antes del DROP.

---

### DROP TABLE sin respaldo previo

```sql
-- WARNING: IRREVERSIBLE
-- La tabla y todos sus datos, índices, constraints y sequences asociados se pierden.
-- Respaldo obligatorio: CREATE TABLE esq_audit.tb_bkp_x_sessionXXX AS SELECT * FROM esq_.tb_x;
```

---

### ALTER COLUMN TYPE con pérdida de precisión

```sql
-- WARNING: IRREVERSIBLE
-- Cambiar de varchar(500) a varchar(50) trunca datos. Cambiar de numeric(18,4) a integer pierde decimales.
-- Verificar que no hay datos que excedan el nuevo tamaño/precisión ANTES de ejecutar.
```

**Mitigación**:
```sql
-- Verificar antes:
SELECT COUNT(*) FROM esq_.tb_x WHERE length(col_x) > 50;
SELECT COUNT(*) FROM esq_.tb_x WHERE col_x != FLOOR(col_x);
```

---

### DROP ... CASCADE

```sql
-- WARNING: IRREVERSIBLE
-- Elimina el objeto Y todos los objetos que dependen de él (views, funciones, constraints).
-- Listar dependencias antes: SELECT * FROM information_schema.constraint_column_usage WHERE table_name = 'tb_x';
```

**Mitigación**: antes de ejecutar, listar todas las dependencias y generar los scripts para recrearlas.

---

### DELETE sin WHERE (o con WHERE muy amplio)

```sql
-- WARNING: IRREVERSIBLE
-- Un DELETE sin cláusula WHERE o con condición demasiado amplia puede vaciar una tabla.
-- Respaldo obligatorio: CREATE TABLE esq_audit.tb_bkp_x_sessionXXX AS SELECT * FROM esq_.tb_x WHERE <condicion>;
```

**Verificación previa recomendada**:
```sql
-- Ejecutar primero como SELECT para ver qué filas afecta:
SELECT COUNT(*) FROM esq_.tb_x WHERE <condicion_del_delete>;
```

---

### UPDATE sin WHERE sobre tabla grande

```sql
-- WARNING: ALTA SUPERFICIE DE IMPACTO
-- Un UPDATE sin WHERE o con condición muy amplia modifica todas las filas.
-- Si es intencional, documentarlo explícitamente en DECISIONS.md.
-- Respaldo obligatorio antes de ejecutar.
```

---

### Eliminar función sin versión anterior conocida

```sql
-- WARNING: IRREVERSIBLE
-- Si no hay registro de la versión anterior de la función (no está en el repo ni en la sesión),
-- no es posible generar un rollback automático.
-- El rollback best-effort debe incluir el cuerpo actual en un comentario para restauración manual.
```

---

### Cambiar tipo de columna con conversión destructiva

Por ejemplo: `varchar` → `integer` donde algunos valores no son números; `timestamp` → `date` perdiendo la hora.

**Mitigación**:
```sql
-- Verificar antes:
SELECT col_x FROM esq_.tb_x WHERE col_x !~ '^\d+$';  -- filas que no son números
```

---

## Formato del header para scripts irreversibles

```sql
-- Archivo: 001-elimina-col-legacy-tb-credito.sql
-- Sesión: sessionXXX-nombre-kebab (YYYY-MM-DD)
-- WARNING: IRREVERSIBLE — DROP COLUMN sin restauración automática posible
-- Respaldo: esq_audit.tb_bkp_credito_col_legacy_sessionXXX (creado en 000-backup.sql)
-- Decisión: DECISIONS.md DEC-XXX — aprobado por [usuario]
BEGIN;
-- cuerpo del script
COMMIT;
```

---

## Verificaciones antes de ejecutar en producción

- [ ] El script de respaldo fue ejecutado y verificado (`SELECT COUNT(*) FROM esq_audit.tb_bkp_...`)
- [ ] La decisión está registrada en `DECISIONS.md`
- [ ] El usuario confirmó explícitamente la ejecución
- [ ] Se tiene el rollback best-effort documentado (aunque sea manual)
- [ ] Se notificó al equipo si el cambio afecta a otros servicios
