"use strict";
// Buddy's authenticated, same-origin provider. No provider credentials enter the editor.
class Provider extends AI.Provider {
    constructor() {
        super("Bob ACP", window.location.origin + "/api/office/ai", "", "v1");
    }
    checkModelCapability(model) {
        model.endpoints.push(AI.Endpoints.Types.v1.Chat_Completions);
        model.options.max_input_tokens = 16384;
        return AI.CapabilitiesUI.Chat;
    }
    getRequestHeaderOptions() {
        const language = window.localStorage.getItem("bob-ui-language") || "en";
        return { "Content-Type": "application/json", "X-Bob-UI-Language": language };
    }
    isUseProxy() { return false; }
}
