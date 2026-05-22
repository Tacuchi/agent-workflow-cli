# Clasificación del incidente — severidad, impacto, comunicación

Aplica a `analyze-conclude` con `## Modality: incident` (legacy: `## Modalidad: incidente`). Toda CONCLUSIONS.md de incidente debe declarar severidad, impacto cliente cuantificado y timeline de comunicación. Sin estos campos, las conclusiones son incompletas.

## Severidad

| Nivel | Criterio | Ejemplos | Comunicación esperada |
|---|---|---|---|
| **SEV1** | Crítico — sistema o flujo principal caído >1h, datos comprometidos, multas regulatorias | Login down >1h, BD principal corrupta, leak de PII | Status page + email a clientes + regulador (si aplica) en <30 min de detección |
| **SEV2** | Degradado — feature secundaria caída, flujo principal degradado >15min y <1h | Latencia 5x normal en endpoint clave, una región caída | Status page + Slack interno; email cliente si dura >30 min |
| **SEV3** | Limitado — afecta <10% usuarios o feature no-crítica | Bug en pantalla específica, error intermitente bajo volumen | Slack interno; sin comunicación externa salvo cliente afectado pregunte |
| **SEV4** | Cosmético / interno — sin impacto en producción visible | Job batch atrasado pero recuperable, alerta interna falsa | Solo Slack del equipo; no requiere post-mortem formal salvo aprendizaje notable |

Declarar la severidad en el **Resumen** y justificar en una línea: "SEV2 — flujo de pago degradado 35 min para 8% de usuarios".

## Impacto cliente — cuantitativo

Cada CONCLUSIONS.md de incidente documenta dentro de **Conclusiones** una `**CN**: Impacto` con las siguientes magnitudes (si no aplica una, decir "no aplica"; nunca dejar vacío):

| Métrica | Cómo cuantificar |
|---|---|
| **Duración total** | Desde primer evento hasta servicio restaurado (no desde detección — el cliente sintió desde el primer evento) |
| **Usuarios afectados** | Número absoluto (preferido) o estimación con metodología clara (ej. "5% de usuarios activos del día = ~12k") |
| **Transacciones impactadas** | Perdidas, duplicadas, en estado inconsistente — separadas. Cantidad + valor monetario si aplica |
| **Datos comprometidos** | Sí/no/qué tipo. Si sí, declarar acción de notificación regulatoria |
| **Costo financiero** | Refunds, créditos, penalidades, costo de remediación. Estimación con rango si no es preciso |
| **Reputación / soporte** | Tickets abiertos relacionados, menciones en redes, NPS si se mide |

Si los datos no están disponibles inmediatamente, CONCLUSIONS.md **declara** que se actualizará con números finales en una fecha objetivo.

## Timeline de comunicación

Bloque obligatorio dentro de la conclusión `**CN**: Timeline` — registra **cuándo y a quién** se comunicó:

| Evento | Canal | Audiencia | Hora (UTC) | Quién |
|---|---|---|---|---|
| Detección interna | Slack #incidents | Equipo on-call | HH:MM | sistema/persona |
| Activación incident commander | Llamada/Slack | Equipo extendido | HH:MM | IC asignado |
| Primer aviso interno | Slack #general | Toda la org | HH:MM | IC |
| Primer aviso externo | Status page | Clientes | HH:MM | Comms / IC |
| Aviso regulador (SEV1 con datos) | Email/portal regulatorio | <ente> | HH:MM | Compliance |
| Resolución comunicada externamente | Status page + email | Clientes | HH:MM | Comms |
| Post-mortem público (si compromete confianza) | Blog/email | Clientes | YYYY-MM-DD | Comms |

### Reglas de comunicación

- **SEV1**: status page actualizada cada 30 min hasta resolución. Cliente dueño de los datos comprometidos contactado directamente <2h.
- **SEV2**: status page actualizada al menos 2 veces (inicio + resolución). Email a clientes si dura >30 min.
- **SEV3**: Slack interno + ticket si cliente lo reporta. Sin proactivo externo.
- **Honestidad**: no minimizar en comunicación pública. "Estamos investigando un incidente que afecta a algunos usuarios" es preferible a silencio o promesas vacías.

## Trazabilidad de acciones

Cada `**RN**` (Recomendación) preventiva cumple:

- **Owner nombrado** (persona o equipo, no "alguien").
- **Fecha objetivo** en formato YYYY-MM-DD.
- **Criterio de "hecho"** medible (ej. "alerta dispara con dataset de prueba" no "mejorar alerting").
- **Priorizada**: P1 = bloqueo de SEV similar futuro; P2 = reduce probabilidad; P3 = mejora detección/respuesta.

CONCLUSIONS.md de incidente se considera **cerrable** sólo cuando todas las recomendaciones P1 tienen owner y fecha.
