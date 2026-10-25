"""Read legacy Office safely; originals never pass through an in-place converter."""

import io
import os
import shutil
import signal
import subprocess
import tempfile
from functools import lru_cache
from pathlib import Path

from app.ingestion.parser_types import ParsedDocument, ParsedSection, ParseError

OFFICE_TIMEOUT_SECONDS = 45
OLE_MAGIC = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"


@lru_cache(maxsize=1)
def _office_tools():
    soffice = shutil.which("libreoffice") or shutil.which("soffice")
    if not soffice:
        return None, None, "旧版 DOC/PPT 需要 LibreOffice 和 UNO，请使用包含转换依赖的 Docker 服务"
    python = Path("/usr/bin/python3")
    if os.name != "posix" or not python.is_file():
        return None, None, "旧版 DOC/PPT 转换需要 Linux LibreOffice UNO 环境，请使用 Docker 服务"
    try:
        result = subprocess.run([str(python), "-c", "import uno"], capture_output=True, timeout=5, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return None, None, "LibreOffice UNO 组件不可用，请安装 python3-uno 或使用 Docker 服务"
    if result.returncode:
        return None, None, "LibreOffice UNO 组件不可用，请安装 python3-uno 或使用 Docker 服务"
    return soffice, str(python), None


def office_availability():
    soffice, python, reason = _office_tools()
    return bool(soffice and python), reason


def _validate_ole(data, ext, streams, max_uncompressed_bytes):
    import olefile

    if not data.startswith(OLE_MAGIC):
        raise ParseError(f"文件内容与 {ext.upper()} 扩展名不符")
    try:
        with olefile.OleFileIO(io.BytesIO(data), raise_defects=olefile.DEFECT_INCORRECT) as ole:
            paths = ole.listdir()
            if any(any(part.casefold() in {"vba", "macros"} or "_vba_project" in part.casefold() for part in path) for path in paths):
                raise ParseError("不接收含宏的旧版 Office 文档")
            if ole.exists("EncryptedPackage") or ole.exists("EncryptionInfo"):
                raise ParseError("Office 文档已加密，请先移除密码")
            if not any(ole.exists(name) for name in streams):
                raise ParseError(f"文件不是有效的 {ext.upper()} 文档")
            if sum(ole.get_size(path) for path in paths) > max_uncompressed_bytes:
                raise ParseError("Office 文档内容超过解析安全限制")
    except ParseError:
        raise
    except (OSError, ValueError, IOError) as error:
        raise ParseError(f"{ext.upper()} 复合文件结构损坏") from error


def validate_doc(data, max_uncompressed_bytes=200 * 1024 * 1024):
    _validate_ole(data, "doc", ("WordDocument",), max_uncompressed_bytes)


def validate_ppt(data, max_uncompressed_bytes=200 * 1024 * 1024):
    _validate_ole(data, "ppt", ("PowerPoint Document",), max_uncompressed_bytes)


def validate_xls(data, max_uncompressed_bytes=200 * 1024 * 1024):
    if data.startswith(OLE_MAGIC):
        _validate_ole(data, "xls", ("Workbook", "Book"), max_uncompressed_bytes)
    elif not data.startswith((b"\x09\x00", b"\x09\x02", b"\x09\x04", b"\x09\x08")):
        raise ParseError("文件内容与 XLS 扩展名不符")
    import xlrd

    try:
        workbook = xlrd.open_workbook(file_contents=data, on_demand=True)
        workbook.release_resources()
    except (xlrd.XLRDError, OSError, ValueError) as error:
        raise ParseError("XLS 无法读取、已加密或文件已损坏") from error


def convert_office(data, extension):
    soffice, python, reason = _office_tools()
    if not soffice or not python:
        raise ParseError(reason)
    target_extension = {"doc": "docx", "ppt": "pptx"}[extension]
    bridge = Path(__file__).with_name("office_bridge.py")
    with tempfile.TemporaryDirectory(prefix="zhicluster-office-") as temporary:
        root = Path(temporary)
        original = root / f"source.{extension}"
        converted = root / f"converted.{target_extension}"
        original.write_bytes(data)
        environment = {key: value for key, value in os.environ.items() if key in {"PATH", "LANG", "LC_ALL", "LD_LIBRARY_PATH"}}
        environment.update({"HOME": str(root), "TMPDIR": str(root), "SAL_USE_VCLPLUGIN": "svp"})
        try:
            process = subprocess.Popen([python, str(bridge), soffice, str(original), str(converted), str(root / "profile")],
                cwd=root, env=environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        except OSError as error:
            raise ParseError("LibreOffice UNO 转换组件无法启动，请检查运行依赖") from error
        try:
            process.communicate(timeout=OFFICE_TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired as error:
            os.killpg(process.pid, signal.SIGKILL)
            process.communicate()
            raise ParseError(f"{extension.upper()} 转换超时，请缩小文档后重试") from error
        if process.returncode or not converted.is_file():
            raise ParseError(f"{extension.upper()} 离线转换失败，文档可能已加密、损坏或需要修复")
        if converted.stat().st_size > 200 * 1024 * 1024:
            raise ParseError("转换后的 Office 文档超过解析安全限制")
        return converted.read_bytes()


def parse_doc(data):
    from app.ingestion.core_formats import parse_docx, validate_docx

    converted = convert_office(data, "doc")
    validate_docx(converted)
    parsed = parse_docx(converted)
    return ParsedDocument(parsed.sections, parsed.plain_text,
        {**parsed.metadata, "format": "doc", "converted_from": "doc", "conversion": "LibreOffice UNO"})


def parse_ppt(data):
    from app.ingestion.formats import parse_pptx, validate_pptx

    converted = convert_office(data, "ppt")
    validate_pptx(converted)
    parsed = parse_pptx(converted)
    return ParsedDocument(parsed.sections, parsed.plain_text,
        {**parsed.metadata, "format": "ppt", "converted_from": "ppt", "conversion": "LibreOffice UNO"})


def parse_xls(data):
    import xlrd

    try:
        workbook = xlrd.open_workbook(file_contents=data, on_demand=True)
        sections, pieces, offset, total_cells = [], [], 0, 0
        try:
            if workbook.nsheets > 256:
                raise ParseError("XLS 工作表数量超过解析安全限制")
            for sheet_index in range(workbook.nsheets):
                sheet = workbook.sheet_by_index(sheet_index)
                if sheet.nrows > 100_000 or sheet.ncols > 1_024:
                    raise ParseError("XLS 行列数量超过解析安全限制")
                total_cells += sheet.nrows * sheet.ncols
                if total_cells > 1_000_000:
                    raise ParseError("XLS 单元格数量超过解析安全限制")
                for row_index in range(sheet.nrows):
                    values = []
                    for cell in sheet.row(row_index):
                        if cell.ctype == xlrd.XL_CELL_EMPTY or cell.ctype == xlrd.XL_CELL_BLANK:
                            values.append("")
                        elif cell.ctype == xlrd.XL_CELL_DATE:
                            date = xlrd.xldate_as_datetime(cell.value, workbook.datemode)
                            values.append(date.time().isoformat() if 0 <= cell.value < 1 else date.isoformat(sep=" ", timespec="seconds"))
                        elif cell.ctype == xlrd.XL_CELL_BOOLEAN:
                            values.append("TRUE" if cell.value else "FALSE")
                        elif cell.ctype == xlrd.XL_CELL_ERROR:
                            values.append(xlrd.error_text_from_code.get(cell.value, "#ERROR"))
                        elif cell.ctype == xlrd.XL_CELL_NUMBER:
                            values.append(format(cell.value, ".15g"))
                        else:
                            values.append(str(cell.value))
                    if not any(value.strip() for value in values):
                        continue
                    text = f"工作表：{sheet.name}\n第 {row_index + 1} 行\t" + "\t".join(values) + "\n"
                    if len(sections) >= 20_000 or offset + len(text) > 20_000_000:
                        raise ParseError("XLS 提取内容超过解析安全限制，请拆分文件")
                    anchor = {"sheet_index": sheet_index + 1, "sheet_name": sheet.name, "row_start": row_index + 1,
                        "row_end": row_index + 1}
                    sections.append(ParsedSection(sheet.name, 1, text, anchor, offset, offset + len(text)))
                    pieces.append(text)
                    offset += len(text)
            return ParsedDocument(sections, "".join(pieces), {"format": "xls", "sheets": workbook.nsheets,
                "formula_values": "cached"})
        finally:
            workbook.release_resources()
    except ParseError:
        raise
    except (xlrd.XLRDError, OSError, ValueError, IndexError) as error:
        raise ParseError("XLS 无法读取、已加密或文件已损坏") from error
