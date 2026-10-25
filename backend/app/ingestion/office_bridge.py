"""Run only with the distribution Python matching LibreOffice's UNO ABI."""

import json
import subprocess
import sys
import time
from pathlib import Path
from uuid import uuid4


def convert(soffice, source, target, profile):
    import uno

    pipe = "zhicluster_" + uuid4().hex
    process = subprocess.Popen([soffice, "-env:UserInstallation=" + profile.as_uri(), "--headless", "--invisible",
        "--nologo", "--nodefault", "--nolockcheck", "--norestore", "--nofirststartwizard",
        f"--accept=pipe,name={pipe};urp;StarOffice.ServiceManager"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    document, desktop = None, None
    try:
        local = uno.getComponentContext()
        resolver = local.ServiceManager.createInstanceWithContext("com.sun.star.bridge.UnoUrlResolver", local)
        deadline = time.monotonic() + 15
        while True:
            try:
                context = resolver.resolve(f"uno:pipe,name={pipe};urp;StarOffice.ComponentContext")
                break
            except Exception:
                if process.poll() is not None or time.monotonic() >= deadline:
                    raise RuntimeError("office_unavailable") from None
                time.sleep(0.1)
        desktop = context.ServiceManager.createInstanceWithContext("com.sun.star.frame.Desktop", context)

        def prop(name, value):
            value_property = uno.createUnoStruct("com.sun.star.beans.PropertyValue")
            value_property.Name, value_property.Value = name, value
            return value_property

        document = desktop.loadComponentFromURL(source.as_uri(), "_blank", 0, (
            prop("Hidden", True), prop("ReadOnly", True), prop("Silent", True),
            prop("MacroExecutionMode", uno.getConstantByName("com.sun.star.document.MacroExecMode.NEVER_EXECUTE")),
            prop("UpdateDocMode", uno.getConstantByName("com.sun.star.document.UpdateDocMode.NO_UPDATE")),
        ))
        if document is None:
            raise RuntimeError("document_unreadable")
        filters = {"docx": "Office Open XML Text", "pptx": "Impress MS PowerPoint 2007 XML"}
        document.storeToURL(target.as_uri(), (prop("FilterName", filters[target.suffix.lstrip(".")]), prop("Overwrite", True)))
    finally:
        if document is not None:
            try:
                document.close(True)
            except Exception:
                try:
                    document.dispose()
                except Exception:
                    pass
        if desktop is not None:
            try:
                desktop.terminate()
            except Exception:
                pass
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()


if __name__ == "__main__":
    try:
        convert(sys.argv[1], *(Path(value).resolve() for value in sys.argv[2:5]))
        print(json.dumps({"ok": True}))
    except Exception:
        print(json.dumps({"ok": False, "error": "office_conversion_failed"}))
        sys.exit(1)
