// Test-only native OCR fixture for cross-platform CLI E2E. No model/network calls.
package main

import (
    "encoding/json"
    "fmt"
    "os"
    "path/filepath"
    "strings"
)

func flag(args []string, key string) string {
    for i, v := range args { if v == key && i+1 < len(args) { return args[i+1] } }
    return ""
}
func main() {
    args := os.Args[1:]
    if len(args)==1 && args[0]=="version" { fmt.Println("OpenCodeReview v1.13.1"); return }
    if len(args)==0 || args[0]!="review" { os.Exit(2) }
    for _, a := range args { if a=="--reviewrouter-managed" { os.Exit(3) } }
    file := "src/example.ts"
    if flag(args, "--repo")=="" { os.Exit(2) }
    mode := "workspace"
    input := map[string]string{"mode":mode}
    if flag(args,"--commit")!="" { mode="commit";input=map[string]string{"mode":mode,"resolved_head":flag(args,"--commit")} }
    if flag(args,"--from")!="" { mode="range";input=map[string]string{"mode":mode,"resolved_base":flag(args,"--from"),"resolved_head":flag(args,"--to")} }
    id := strings.Repeat("a", 64)
    item := map[string]string{"item_id":id,"path":file}
    selected := []interface{}{item}
    previewFiles := []interface{}{map[string]interface{}{"path":file,"status":"modified","will_review":true}}
    if _,err:=os.Stat(filepath.Join(flag(args,"--repo"),"src","new.ts")); err==nil {
        extra:=map[string]string{"item_id":strings.Repeat("b",64),"path":"src/new.ts"}
        selected=append(selected,extra)
        previewFiles=append(previewFiles,map[string]interface{}{"path":"src/new.ts","status":"added","will_review":true})
    }
    for _, a := range args {
        if a=="--preview" {
            json.NewEncoder(os.Stdout).Encode(map[string]interface{}{"files":previewFiles,"reviewable_count":len(selected),"total_files":len(selected)})
            return
        }
    }
    status := os.Getenv("RR_FAKE_OCR_STATUS")
    if status=="" { status="complete" }
    completed := selected;failed:=[]interface{}{}
    if status!="complete" { completed=[]interface{}{};failed=selected }
    comments := []interface{}{map[string]interface{}{"path":file,"start_line":1,"end_line":1,"severity":"high","content":"Check a changed value","thinking":"must not escape"}}
    output:=map[string]interface{}{"status":status,"llm":map[string]string{"provider":"fixture","model":"mock-v1"},"comments":comments,
        "manifest":map[string]interface{}{"schema_version":"ocr.run-manifest/v1","operation":"review","terminal_state":status,"input":input,
            "execution":map[string]string{"provider":"fixture","model":"mock-v1"},
            "coverage":map[string]interface{}{"selected":selected,"completed":completed,"reused":[]interface{}{},"failed":failed,"waived":[]interface{}{}}}}
    json.NewEncoder(os.Stdout).Encode(output)
}
