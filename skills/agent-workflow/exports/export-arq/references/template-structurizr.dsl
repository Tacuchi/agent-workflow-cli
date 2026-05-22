// Plantilla Structurizr DSL — workspace.dsl
//
// Default de `/agent-workflow:export-arq` desde v1.1 (session077): cuando se invoca el comando
// (con o sin `--diagrams structurizr`), el skill rellena esta plantilla con los nodos
// del corpus + fuentes declaradas en AW-PROJECT. Se omite sólo con `--diagrams mermaid`
// (caso en que el render queda como Mermaid nativo dentro de arquitectura.md).
//
// El render visual lo hace el lector con structurizr.com/dsl (online gratis)
// o con structurizr-lite (Docker image local). Adicionalmente, `arquitectura.md`
// incluye un Mermaid auxiliar embebido derivado del DSL para lectura offline.
//
// Referencia oficial: https://docs.structurizr.com/dsl
// Las llaves dobles {{PLACEHOLDER}} se reemplazan por el render del skill.

workspace "{{PRODUCTO}}" "{{DESCRIPCION_CORTA}}" {

  model {
    // ===== Personas =====
    {{PERSONS_DSL}}
    // Ejemplo render esperado:
    // dev = person "Developer" "Miembro del equipo"

    // ===== Sistema bajo análisis =====
    {{SYSTEM_DSL}}
    // Ejemplo render esperado:
    // sistema = softwareSystem "Runtime agent-workflow" "Coordinación de sesiones" {
    //   cli = container "agent-workflow CLI" "Node.js + TypeScript" "Línea de comandos"
    //   plugin = container "agent-workflow" "Markdown skills + JSON hooks" "Skills y comandos"
    //   marketplace = container "qtc-plugins-marketplace" "JSON manifest" "Distribución"
    // }

    // ===== Sistemas externos =====
    {{EXTERNAL_SYSTEMS_DSL}}
    // Ejemplo render esperado:
    // claude = softwareSystem "Claude Code" "Host AI principal" "External"
    // codex = softwareSystem "Codex" "Host AI alternativo" "External"
    // mcp_cert = softwareSystem "<mcp-cert> MCP" "Fuente de datos read-only" "External"

    // ===== Relaciones =====
    {{RELATIONSHIPS_DSL}}
    // Ejemplo render esperado:
    // dev -> sistema "Usa"
    // sistema -> claude "Hooks + skills"
    // sistema -> codex "Hooks + skills"
    // sistema -> mcp_cert "SELECT/EXPLAIN/\d"
  }

  views {
    // ===== Vista C4 Context =====
    systemContext {{SYSTEM_REF}} "Context" {
      include *
      autoLayout
    }

    // ===== Vista C4 Container =====
    container {{SYSTEM_REF}} "Container" {
      include *
      autoLayout
    }

    // ===== Vista C4 Component (por contenedor relevante) =====
    {{COMPONENT_VIEWS_DSL}}
    // Ejemplo render esperado por cada contenedor con C4 Component:
    // component plugin "Plugin-Components" {
    //   include *
    //   autoLayout
    // }

    theme default
    // Alternativas: theme https://static.structurizr.com/themes/microsoft-azure-2023.01.24/theme.json
  }
}
