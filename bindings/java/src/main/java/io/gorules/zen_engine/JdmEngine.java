package io.gorules.zen_engine;

import java.util.*;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * In-process JDM (JSON Decision Model) Evaluation Engine for Java.
 */
public final class JdmEngine {

    // Simple robust recursive descent JSON parser
    public static final class SimpleJson {
        private final String src;
        private int pos = 0;

        public SimpleJson(String src) {
            this.src = src != null ? src.trim() : "";
        }

        public static Object parse(String json) {
            return new SimpleJson(json).parseValue();
        }

        private void skipWhitespace() {
            while (pos < src.length() && Character.isWhitespace(src.charAt(pos))) {
                pos++;
            }
        }

        private Object parseValue() {
            skipWhitespace();
            if (pos >= src.length()) return null;
            char c = src.charAt(pos);
            if (c == '{') return parseObject();
            if (c == '[') return parseArray();
            if (c == '"' || c == '\'') return parseString();
            if (c == 't' && src.startsWith("true", pos)) { pos += 4; return Boolean.TRUE; }
            if (c == 'f' && src.startsWith("false", pos)) { pos += 5; return Boolean.FALSE; }
            if (c == 'n' && src.startsWith("null", pos)) { pos += 4; return null; }
            return parseNumber();
        }

        private Map<String, Object> parseObject() {
            Map<String, Object> map = new LinkedHashMap<>();
            pos++; // consume '{'
            skipWhitespace();
            if (pos < src.length() && src.charAt(pos) == '}') {
                pos++;
                return map;
            }
            while (pos < src.length()) {
                skipWhitespace();
                String key = parseString();
                skipWhitespace();
                if (pos < src.length() && src.charAt(pos) == ':') pos++;
                Object val = parseValue();
                map.put(key, val);
                skipWhitespace();
                if (pos < src.length() && src.charAt(pos) == ',') {
                    pos++;
                } else if (pos < src.length() && src.charAt(pos) == '}') {
                    pos++;
                    break;
                }
            }
            return map;
        }

        private List<Object> parseArray() {
            List<Object> list = new ArrayList<>();
            pos++; // consume '['
            skipWhitespace();
            if (pos < src.length() && src.charAt(pos) == ']') {
                pos++;
                return list;
            }
            while (pos < src.length()) {
                list.add(parseValue());
                skipWhitespace();
                if (pos < src.length() && src.charAt(pos) == ',') {
                    pos++;
                } else if (pos < src.length() && src.charAt(pos) == ']') {
                    pos++;
                    break;
                }
            }
            return list;
        }

        private String parseString() {
            char quote = src.charAt(pos++);
            StringBuilder sb = new StringBuilder();
            while (pos < src.length()) {
                char c = src.charAt(pos++);
                if (c == '\\' && pos < src.length()) {
                    char esc = src.charAt(pos++);
                    if (esc == 'n') sb.append('\n');
                    else if (esc == 't') sb.append('\t');
                    else if (esc == 'r') sb.append('\r');
                    else sb.append(esc);
                } else if (c == quote) {
                    break;
                } else {
                    sb.append(c);
                }
            }
            return sb.toString();
        }

        private Object parseNumber() {
            int start = pos;
            if (pos < src.length() && (src.charAt(pos) == '-' || src.charAt(pos) == '+')) pos++;
            while (pos < src.length() && (Character.isDigit(src.charAt(pos)) || src.charAt(pos) == '.' || src.charAt(pos) == 'e' || src.charAt(pos) == 'E')) {
                pos++;
            }
            String numStr = src.substring(start, pos);
            try {
                if (numStr.contains(".") || numStr.contains("e") || numStr.contains("E")) {
                    return Double.parseDouble(numStr);
                }
                long l = Long.parseLong(numStr);
                if (l >= Integer.MIN_VALUE && l <= Integer.MAX_VALUE) {
                    return (int) l;
                }
                return l;
            } catch (NumberFormatException e) {
                return numStr;
            }
        }

        public static String stringify(Object obj) {
            if (obj == null) return "null";
            if (obj instanceof String s) return "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n") + "\"";
            if (obj instanceof Number || obj instanceof Boolean) return String.valueOf(obj);
            if (obj instanceof Map<?, ?> m) {
                StringBuilder sb = new StringBuilder("{");
                boolean first = true;
                for (Map.Entry<?, ?> entry : m.entrySet()) {
                    if (!first) sb.append(",");
                    first = false;
                    sb.append(stringify(String.valueOf(entry.getKey()))).append(":").append(stringify(entry.getValue()));
                }
                return sb.append("}").toString();
            }
            if (obj instanceof Iterable<?> iter) {
                StringBuilder sb = new StringBuilder("[");
                boolean first = true;
                for (Object item : iter) {
                    if (!first) sb.append(",");
                    first = false;
                    sb.append(stringify(item));
                }
                return sb.append("]").toString();
            }
            return "\"" + obj + "\"";
        }
    }

    public static ZenResponse evaluateGraph(Map<String, Object> graph, Map<String, Object> inputData, boolean traceEnabled) {
        long startNs = System.nanoTime();

        @SuppressWarnings("unchecked")
        List<Map<String, Object>> nodes = (List<Map<String, Object>>) graph.getOrDefault("nodes", Collections.emptyList());
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> edges = (List<Map<String, Object>>) graph.getOrDefault("edges", Collections.emptyList());

        Map<String, Map<String, Object>> nodeMap = new LinkedHashMap<>();
        Map<String, Integer> inDegrees = new HashMap<>();
        Map<String, List<String>> outEdges = new HashMap<>();

        for (Map<String, Object> node : nodes) {
            String id = (String) node.get("id");
            nodeMap.put(id, node);
            inDegrees.put(id, 0);
            outEdges.put(id, new ArrayList<>());
        }

        for (Map<String, Object> edge : edges) {
            String src = (String) edge.get("sourceId");
            String tgt = (String) edge.get("targetId");
            if (inDegrees.containsKey(tgt)) inDegrees.put(tgt, inDegrees.get(tgt) + 1);
            if (outEdges.containsKey(src)) outEdges.get(src).add(tgt);
        }

        Queue<String> queue = new ArrayDeque<>();
        for (Map.Entry<String, Integer> entry : inDegrees.entrySet()) {
            if (entry.getValue() == 0) queue.add(entry.getKey());
        }

        List<String> execOrder = new ArrayList<>();
        while (!queue.isEmpty()) {
            String curr = queue.poll();
            execOrder.add(curr);
            for (String tgt : outEdges.getOrDefault(curr, Collections.emptyList())) {
                inDegrees.put(tgt, inDegrees.get(tgt) - 1);
                if (inDegrees.get(tgt) == 0) queue.add(tgt);
            }
        }

        if (execOrder.size() < nodeMap.size()) {
            throw new IllegalStateException("Graph cycle detected in decision model");
        }

        Map<String, Object> workingCtx = deepClone(inputData);
        List<Map<String, Object>> traces = new ArrayList<>();
        Object finalResult = workingCtx;

        for (String nid : execOrder) {
            Map<String, Object> node = nodeMap.get(nid);
            String type = (String) node.get("type");
            @SuppressWarnings("unchecked")
            Map<String, Object> content = (Map<String, Object>) node.getOrDefault("content", Collections.emptyMap());

            Map<String, Object> nodeTrace = new LinkedHashMap<>();
            nodeTrace.put("id", nid);
            nodeTrace.put("name", node.getOrDefault("name", nid));
            nodeTrace.put("type", type);

            switch (type) {
                case "inputNode" -> {
                    @SuppressWarnings("unchecked")
                    Map<String, Object> schema = (Map<String, Object>) content.get("schema");
                    if (schema != null) {
                        validateSchema(workingCtx, schema, "request");
                    }
                }
                case "decisionTableNode" -> {
                    TableResult tr = evaluateDecisionTable(content, workingCtx);
                    nodeTrace.put("outputSnapshot", tr.result);
                    nodeTrace.put("ruleTrace", tr.ruleTrace);
                    if (tr.result instanceof List<?> list) {
                        String name = (String) node.getOrDefault("name", nid);
                        workingCtx.put(name, list);
                        workingCtx.put("results", list);
                    } else if (tr.result instanceof Map<?, ?> m) {
                        for (Map.Entry<?, ?> entry : m.entrySet()) {
                            setByPath(workingCtx, String.valueOf(entry.getKey()), entry.getValue());
                        }
                    }
                }
                case "expressionNode" -> {
                    @SuppressWarnings("unchecked")
                    List<Map<String, Object>> exprs = (List<Map<String, Object>>) content.getOrDefault("expressions", Collections.emptyList());
                    Map<String, Object> outVars = new LinkedHashMap<>();
                    for (Map<String, Object> exp : exprs) {
                        String key = (String) exp.get("key");
                        String valExpr = (String) exp.get("value");
                        Object res = evalExpression(valExpr, workingCtx);
                        outVars.put(key, res);
                        setByPath(workingCtx, key, res);
                    }
                    nodeTrace.put("outputSnapshot", outVars);
                }
                case "outputNode" -> {
                    if (content.get("schema") instanceof List<?> schemaList) {
                        Map<String, Object> proj = new LinkedHashMap<>();
                        for (Object k : schemaList) {
                            String path = String.valueOf(k);
                            proj.put(path, getByPath(workingCtx, path));
                        }
                        finalResult = proj;
                    } else if (content.get("schema") instanceof Map<?, ?> schemaMap) {
                        @SuppressWarnings("unchecked")
                        Map<String, Object> sm = (Map<String, Object>) schemaMap;
                        validateSchema(workingCtx, sm, "response");
                        finalResult = workingCtx;
                    } else {
                        finalResult = workingCtx;
                    }
                    nodeTrace.put("outputSnapshot", finalResult);
                }
            }
            traces.add(nodeTrace);
        }

        long elapsedNs = System.nanoTime() - startNs;
        String perfStr = String.format(Locale.ROOT, "%.1fµs", elapsedNs / 1000.0);

        return new ZenResponse(finalResult, perfStr, traceEnabled ? traces : null);
    }

    private record TableResult(Object result, List<Map<String, Object>> ruleTrace) {}

    private static TableResult evaluateDecisionTable(Map<String, Object> content, Map<String, Object> ctx) {
        String hitPolicy = ((String) content.getOrDefault("hitPolicy", "first")).toLowerCase();
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> inputs = (List<Map<String, Object>>) content.getOrDefault("inputs", Collections.emptyList());
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> outputs = (List<Map<String, Object>>) content.getOrDefault("outputs", Collections.emptyList());
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> rules = (List<Map<String, Object>>) content.getOrDefault("rules", Collections.emptyList());

        List<Object> matchedOutputs = new ArrayList<>();
        List<Map<String, Object>> ruleTraces = new ArrayList<>();

        for (Map<String, Object> rule : rules) {
            String ruleId = (String) rule.get("_id");
            boolean passed = true;

            for (Map<String, Object> inp : inputs) {
                String colId = (String) inp.get("id");
                String fieldPath = (String) inp.getOrDefault("field", colId);
                Object cellVal = rule.get(colId);
                String cellStr = cellVal != null ? String.valueOf(cellVal).trim() : "";
                if (cellVal == null || cellStr.isEmpty() || "-".equals(cellStr)) {
                    continue;
                }
                Object val = getByPath(ctx, fieldPath);
                if (!evaluateUnary(cellStr, val, ctx)) {
                    passed = false;
                    break;
                }
            }

            Map<String, Object> rt = new HashMap<>();
            rt.put("ruleId", ruleId);
            rt.put("passed", passed);
            ruleTraces.add(rt);

            if (passed) {
                Map<String, Object> rowOut = new LinkedHashMap<>();
                for (Map<String, Object> out : outputs) {
                    String colId = (String) out.get("id");
                    String fieldPath = (String) out.getOrDefault("field", colId);
                    Object rawVal = rule.get(colId);
                    Object outVal = null;
                    if (rawVal instanceof String s) {
                        String st = s.trim();
                        if (st.startsWith("=")) {
                            outVal = evalExpression(st.substring(1), ctx);
                        } else {
                            outVal = parseLiteral(st);
                        }
                    } else {
                        outVal = rawVal;
                    }
                    setByPath(rowOut, fieldPath, outVal);
                }

                if ("first".equals(hitPolicy)) {
                    return new TableResult(rowOut, ruleTraces);
                }
                matchedOutputs.add(rowOut);
            }
        }

        if ("first".equals(hitPolicy)) {
            return new TableResult(Collections.emptyMap(), ruleTraces);
        }
        return new TableResult(matchedOutputs, ruleTraces);
    }

    public static boolean evaluateUnary(String testStr, Object val, Map<String, Object> ctx) {
        String s = testStr != null ? testStr.trim() : "";
        if (s.isEmpty() || "-".equals(s)) return true;

        // Dynamic placeholder ? or $
        if (hasPlaceholder(s)) {
            String subbed = substitutePlaceholder(s, val);
            Object res = evalExpression(subbed, ctx);
            if (res instanceof Boolean b) return b;
            return res != null && !Boolean.FALSE.equals(res) && !"".equals(res);
        }

        // Negation: not(...)
        if (s.toLowerCase().startsWith("not(") && s.endsWith(")")) {
            String inner = s.substring(4, s.length() - 1).trim();
            return !evaluateUnary(inner, val, ctx);
        }

        // in [...]
        if (s.toLowerCase().startsWith("in [") && s.endsWith("]")) {
            String inner = s.substring(4, s.length() - 1);
            List<String> items = splitCSV(inner);
            for (String item : items) {
                if (looseEquals(val, parseLiteral(item))) return true;
            }
            return false;
        }

        // not in [...]
        if (s.toLowerCase().startsWith("not in [") && s.endsWith("]")) {
            String inner = s.substring(8, s.length() - 1);
            List<String> items = splitCSV(inner);
            for (String item : items) {
                if (looseEquals(val, parseLiteral(item))) return false;
            }
            return true;
        }

        // Comma-separated list shorthand (e.g. 10, 20, 30 or 'VIP', 'Gold')
        if (s.contains(",") && !s.startsWith("[") && !s.startsWith("(") && !s.toLowerCase().startsWith("in ")) {
            List<String> parts = splitCSV(s);
            if (parts.size() > 1) {
                for (String part : parts) {
                    if (evaluateUnary(part.trim(), val, ctx)) return true;
                }
                return false;
            }
        }

        // Range: [min..max]
        Matcher rangeMatcher = Pattern.compile("^([\\[\\(])\\s*(-?\\d+(?:\\.\\d+)?)\\s*\\.\\.\\s*(-?\\d+(?:\\.\\d+)?)\\s*([\\]\\)])$").matcher(s);
        if (rangeMatcher.matches()) {
            String lBr = rangeMatcher.group(1);
            double minV = Double.parseDouble(rangeMatcher.group(2));
            double maxV = Double.parseDouble(rangeMatcher.group(3));
            String rBr = rangeMatcher.group(4);
            Double num = toDouble(val);
            if (num == null) return false;
            boolean minPass = "[".equals(lBr) ? num >= minV : num > minV;
            boolean maxPass = "]".equals(rBr) ? num <= maxV : num < maxV;
            return minPass && maxPass;
        }

        // Comparisons
        Matcher compMatcher = Pattern.compile("^(>=|<=|!=|==|=|>|<)\\s*+(.*)$").matcher(s);
        if (compMatcher.matches()) {
            String op = compMatcher.group(1);
            if ("=".equals(op)) op = "==";
            Object target = parseLiteral(compMatcher.group(2));
            Double vNum = toDouble(val);
            Double tNum = toDouble(target);
            if (vNum != null && tNum != null && !(val instanceof Boolean) && !(target instanceof Boolean)) {
                return switch (op) {
                    case ">=" -> vNum >= tNum;
                    case "<=" -> vNum <= tNum;
                    case ">" -> vNum > tNum;
                    case "<" -> vNum < tNum;
                    case "==" -> vNum.equals(tNum);
                    case "!=" -> !vNum.equals(tNum);
                    default -> false;
                };
            }
            return switch (op) {
                case "==" -> looseEquals(val, target);
                case "!=" -> !looseEquals(val, target);
                default -> false;
            };
        }

        return looseEquals(val, parseLiteral(s));
    }

    private static boolean hasPlaceholder(String s) {
        boolean inSingle = false, inDouble = false;
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '\'' && !inDouble && (i == 0 || s.charAt(i - 1) != '\\')) inSingle = !inSingle;
            else if (c == '"' && !inSingle && (i == 0 || s.charAt(i - 1) != '\\')) inDouble = !inDouble;
            else if (!inSingle && !inDouble && (c == '?' || c == '$')) return true;
        }
        return false;
    }

    private static String substitutePlaceholder(String s, Object val) {
        boolean inSingle = false, inDouble = false;
        StringBuilder sb = new StringBuilder();
        String rep = String.valueOf(val);
        if (val instanceof String str) {
            rep = "'" + str.replace("'", "\\'") + "'";
        }
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '\'' && !inDouble && (i == 0 || s.charAt(i - 1) != '\\')) {
                inSingle = !inSingle;
                sb.append(c);
            } else if (c == '"' && !inSingle && (i == 0 || s.charAt(i - 1) != '\\')) {
                inDouble = !inDouble;
                sb.append(c);
            } else if (!inSingle && !inDouble && (c == '?' || c == '$')) {
                sb.append(rep);
            } else {
                sb.append(c);
            }
        }
        return sb.toString();
    }

    public static Object evalExpression(String expr, Map<String, Object> ctx) {
        String s = expr != null ? expr.trim() : "";
        if (s.isEmpty()) return null;
        if ("true".equalsIgnoreCase(s)) return Boolean.TRUE;
        if ("false".equalsIgnoreCase(s)) return Boolean.FALSE;
        if ("null".equals(s) || "nil".equals(s)) return null;

        // Function call: startsWith, endsWith, matches, map, filter, unique, join
        Matcher fnMatcher = Pattern.compile("^(\\w+)\\((.*)\\)$").matcher(s);
        if (fnMatcher.matches()) {
            String fn = fnMatcher.group(1);
            List<String> args = splitCSV(fnMatcher.group(2));
            switch (fn) {
                case "startsWith", "starts_with" -> {
                    if (args.size() == 2) {
                        String val = String.valueOf(evalExpression(args.get(0), ctx));
                        String prefix = String.valueOf(parseLiteral(args.get(1)));
                        return val.startsWith(prefix);
                    }
                }
                case "endsWith", "ends_with" -> {
                    if (args.size() == 2) {
                        String val = String.valueOf(evalExpression(args.get(0), ctx));
                        String suffix = String.valueOf(parseLiteral(args.get(1)));
                        return val.endsWith(suffix);
                    }
                }
                case "matches" -> {
                    if (args.size() == 2) {
                        String val = String.valueOf(evalExpression(args.get(0), ctx));
                        String regex = String.valueOf(parseLiteral(args.get(1)));
                        try {
                            return Pattern.compile(regex).matcher(val).find();
                        } catch (Exception e) {
                            return false;
                        }
                    }
                }
                case "map" -> {
                    if (args.size() == 2) {
                        Object target = evalExpression(args.get(0), ctx);
                        String field = String.valueOf(parseLiteral(args.get(1)));
                        List<Object> res = new ArrayList<>();
                        if (target instanceof List<?> list) {
                            for (Object item : list) {
                                if (item instanceof Map<?, ?> m) res.add(m.get(field));
                            }
                        }
                        return res;
                    }
                }
                case "filter" -> {
                    if (args.size() >= 2) {
                        Object target = evalExpression(args.get(0), ctx);
                        String field = String.valueOf(parseLiteral(args.get(1)));
                        Object exp = args.size() > 2 ? parseLiteral(args.get(2)) : Boolean.TRUE;
                        List<Object> res = new ArrayList<>();
                        if (target instanceof List<?> list) {
                            for (Object item : list) {
                                if (item instanceof Map<?, ?> m && looseEquals(m.get(field), exp)) {
                                    res.add(m);
                                }
                            }
                        }
                        return res;
                    }
                }
                case "unique" -> {
                    if (args.size() == 1) {
                        Object target = evalExpression(args.get(0), ctx);
                        Set<Object> seen = new LinkedHashSet<>();
                        if (target instanceof List<?> list) seen.addAll(list);
                        return new ArrayList<>(seen);
                    }
                }
                case "join" -> {
                    if (args.size() == 2) {
                        Object target = evalExpression(args.get(0), ctx);
                        String sep = String.valueOf(parseLiteral(args.get(1)));
                        List<String> strs = new ArrayList<>();
                        if (target instanceof List<?> list) {
                            for (Object o : list) strs.add(String.valueOf(o));
                        }
                        return String.join(sep, strs);
                    }
                }
            }
        }

        // Context path retrieval
        Object fromCtx = getByPath(ctx, s);
        if (fromCtx != null) return fromCtx;

        return parseLiteral(s);
    }

    public static Object getByPath(Object obj, String path) {
        if (path == null || path.isEmpty() || "$".equals(path) || obj == null) return obj;
        String[] parts = path.split("\\.");
        Object curr = obj;
        for (String p : parts) {
            if (curr == null) return null;
            if (curr instanceof Map<?, ?> m) curr = m.get(p);
            else return null;
        }
        return curr;
    }

    @SuppressWarnings("unchecked")
    public static void setByPath(Map<String, Object> obj, String path, Object val) {
        if (path == null || path.isEmpty() || "$".equals(path)) {
            if (val instanceof Map<?, ?> m) obj.putAll((Map<String, Object>) m);
            return;
        }
        String[] parts = path.split("\\.");
        Map<String, Object> curr = obj;
        for (int i = 0; i < parts.length - 1; i++) {
            String p = parts[i];
            Object next = curr.get(p);
            if (next instanceof Map<?, ?> m) {
                curr = (Map<String, Object>) m;
            } else {
                Map<String, Object> newMap = new LinkedHashMap<>();
                curr.put(p, newMap);
                curr = newMap;
            }
        }
        curr.put(parts[parts.length - 1], val);
    }

    private static Object parseLiteral(String s) {
        if (s == null) return null;
        String str = s.trim();
        if ("true".equalsIgnoreCase(str)) return Boolean.TRUE;
        if ("false".equalsIgnoreCase(str)) return Boolean.FALSE;
        if ("null".equals(str)) return null;
        if ((str.startsWith("'") && str.endsWith("'")) || (str.startsWith("\"") && str.endsWith("\""))) {
            return str.substring(1, str.length() - 1);
        }
        try {
            if (str.contains(".")) return Double.parseDouble(str);
            long l = Long.parseLong(str);
            if (l >= Integer.MIN_VALUE && l <= Integer.MAX_VALUE) return (int) l;
            return l;
        } catch (NumberFormatException ignored) {}
        return str;
    }

    private static Double toDouble(Object val) {
        if (val instanceof Number n) return n.doubleValue();
        if (val instanceof String str) {
            try { return Double.parseDouble(str.trim()); } catch (NumberFormatException ignored) {}
        }
        return null;
    }

    private static boolean looseEquals(Object a, Object b) {
        if (Objects.equals(a, b)) return true;
        Double da = toDouble(a);
        Double db = toDouble(b);
        if (da != null && db != null) return da.equals(db);
        return String.valueOf(a).equals(String.valueOf(b));
    }

    private static List<String> splitCSV(String s) {
        List<String> parts = new ArrayList<>();
        StringBuilder sb = new StringBuilder();
        boolean inSingle = false, inDouble = false;
        int depth = 0;
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '\'' && !inDouble && (i == 0 || s.charAt(i - 1) != '\\')) inSingle = !inSingle;
            else if (c == '"' && !inSingle && (i == 0 || s.charAt(i - 1) != '\\')) inDouble = !inDouble;
            else if ((c == '[' || c == '(') && !inSingle && !inDouble) depth++;
            else if ((c == ']' || c == ')') && !inSingle && !inDouble) depth--;
            else if (c == ',' && !inSingle && !inDouble && depth == 0) {
                parts.add(sb.toString().trim());
                sb.setLength(0);
                continue;
            }
            sb.append(c);
        }
        if (!sb.isEmpty()) parts.add(sb.toString().trim());
        return parts;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> deepClone(Map<String, Object> orig) {
        return (Map<String, Object>) SimpleJson.parse(SimpleJson.stringify(orig));
    }

    private static void validateSchema(Map<String, Object> data, Map<String, Object> schema, String path) {
        if (schema.get("required") instanceof List<?> req) {
            for (Object r : req) {
                String key = String.valueOf(r);
                if (!data.containsKey(key) || data.get(key) == null) {
                    throw new IllegalArgumentException(path + "." + key + " is required");
                }
            }
        }
        if (schema.get("properties") instanceof Map<?, ?> props) {
            for (Map.Entry<?, ?> entry : props.entrySet()) {
                String k = String.valueOf(entry.getKey());
                if (data.containsKey(k) && entry.getValue() instanceof Map<?, ?> propMap) {
                    Object minVal = propMap.get("minimum");
                    if (minVal instanceof Number n) {
                        Double val = toDouble(data.get(k));
                        if (val != null && val < n.doubleValue()) {
                            throw new IllegalArgumentException(path + "." + k + ": value " + val + " is less than minimum " + n);
                        }
                    }
                }
            }
        }
    }
}
