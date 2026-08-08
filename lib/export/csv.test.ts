import { describe, expect, it } from "vitest";
import { buildCsvFileName, toCsv, UTF8_BOM, withUtf8Bom, type CsvColumn } from "./csv";

interface SampleRow {
  title: string;
  status: string;
  progress: number;
  assignee: string | null;
  note?: string;
}

const SAMPLE_COLUMNS: CsvColumn<SampleRow>[] = [
  { header: "タイトル", value: (row) => row.title },
  { header: "ステータス", value: (row) => row.status },
  { header: "進捗", value: (row) => row.progress },
  { header: "担当者", value: (row) => row.assignee },
  { header: "メモ", value: (row) => row.note },
];

function row(overrides: Partial<SampleRow> = {}): SampleRow {
  return {
    title: "タスクA",
    status: "未着手",
    progress: 0,
    assignee: "山田",
    ...overrides,
  };
}

describe("toCsv", () => {
  it("ヘッダー行と値の行を CRLF 区切りで返す（RFC 4180）", () => {
    const csv = toCsv([row()], SAMPLE_COLUMNS);

    expect(csv).toBe("タイトル,ステータス,進捗,担当者,メモ\r\nタスクA,未着手,0,山田,");
  });

  it("行が 0 件でもヘッダー行だけは出す（列構成が分かる CSV にするため）", () => {
    expect(toCsv([], SAMPLE_COLUMNS)).toBe("タイトル,ステータス,進捗,担当者,メモ");
  });

  it("列定義の順序どおりに値を並べる", () => {
    const reversed: CsvColumn<SampleRow>[] = [
      { header: "進捗", value: (r) => r.progress },
      { header: "タイトル", value: (r) => r.title },
    ];

    expect(toCsv([row({ title: "X", progress: 40 })], reversed)).toBe("進捗,タイトル\r\n40,X");
  });

  it("複数行を CRLF で連結する", () => {
    const columns: CsvColumn<SampleRow>[] = [{ header: "タイトル", value: (r) => r.title }];

    expect(toCsv([row({ title: "A" }), row({ title: "B" })], columns)).toBe("タイトル\r\nA\r\nB");
  });

  describe("RFC 4180 のエスケープ", () => {
    const titleOnly: CsvColumn<SampleRow>[] = [{ header: "タイトル", value: (r) => r.title }];

    it("カンマを含む値をダブルクォートで囲む", () => {
      expect(toCsv([row({ title: "設計,実装" })], titleOnly)).toBe('タイトル\r\n"設計,実装"');
    });

    it("ダブルクォートを 2 つ重ねて囲む", () => {
      expect(toCsv([row({ title: '"引用"あり' })], titleOnly)).toBe('タイトル\r\n"""引用""あり"');
    });

    it("LF を含む値をダブルクォートで囲む", () => {
      expect(toCsv([row({ title: "1行目\n2行目" })], titleOnly)).toBe('タイトル\r\n"1行目\n2行目"');
    });

    it("CR を含む値をダブルクォートで囲む", () => {
      expect(toCsv([row({ title: "1行目\r2行目" })], titleOnly)).toBe('タイトル\r\n"1行目\r2行目"');
    });

    it("CRLF を含む値をダブルクォートで囲む", () => {
      expect(toCsv([row({ title: "1行目\r\n2行目" })], titleOnly)).toBe(
        'タイトル\r\n"1行目\r\n2行目"',
      );
    });

    it("エスケープが不要な値はダブルクォートで囲まない", () => {
      expect(toCsv([row({ title: "ふつうのタイトル" })], titleOnly)).toBe(
        "タイトル\r\nふつうのタイトル",
      );
    });

    it("ヘッダー名もエスケープの対象にする", () => {
      const columns: CsvColumn<SampleRow>[] = [{ header: "備考,補足", value: (r) => r.title }];

      expect(toCsv([row({ title: "A" })], columns)).toBe('"備考,補足"\r\nA');
    });
  });

  describe("null / undefined / 数値の扱い", () => {
    it("null を空文字にする", () => {
      const columns: CsvColumn<SampleRow>[] = [{ header: "担当者", value: (r) => r.assignee }];

      expect(toCsv([row({ assignee: null })], columns)).toBe("担当者\r\n");
    });

    it("undefined を空文字にする", () => {
      const columns: CsvColumn<SampleRow>[] = [{ header: "メモ", value: (r) => r.note }];

      expect(toCsv([row()], columns)).toBe("メモ\r\n");
    });

    it("数値を文字列化する（0 を空文字にしない）", () => {
      const columns: CsvColumn<SampleRow>[] = [{ header: "進捗", value: (r) => r.progress }];

      expect(toCsv([row({ progress: 0 }), row({ progress: 100 })], columns)).toBe(
        "進捗\r\n0\r\n100",
      );
    });

    it("空文字はそのまま空欄にする", () => {
      const columns: CsvColumn<SampleRow>[] = [{ header: "タイトル", value: (r) => r.title }];

      expect(toCsv([row({ title: "" })], columns)).toBe("タイトル\r\n");
    });
  });

  it("同じ列定義を別のデータに使い回せる（画面ごとに列を定義できる形になっている）", () => {
    const columns: CsvColumn<{ name: string }>[] = [{ header: "名前", value: (r) => r.name }];

    expect(toCsv([{ name: "甲" }], columns)).toBe("名前\r\n甲");
    expect(toCsv([{ name: "乙" }], columns)).toBe("名前\r\n乙");
  });
});

describe("withUtf8Bom", () => {
  it("先頭に UTF-8 BOM を付ける（Excel の文字化け対策）", () => {
    const csv = toCsv([row()], [{ header: "タイトル", value: (r) => r.title }]);

    expect(withUtf8Bom(csv)).toBe(`${UTF8_BOM}${csv}`);
    expect(withUtf8Bom(csv).codePointAt(0)).toBe(0xfeff);
  });

  it("すでに BOM が付いている場合は二重に付けない", () => {
    expect(withUtf8Bom(`${UTF8_BOM}あ,い`)).toBe(`${UTF8_BOM}あ,い`);
  });

  it("空文字にも BOM を付ける", () => {
    expect(withUtf8Bom("")).toBe(UTF8_BOM);
  });

  it("toCsv 自体は BOM を付けない（機械処理向けに BOM なしを選べる）", () => {
    expect(toCsv([row()], [{ header: "タイトル", value: (r) => r.title }])).not.toContain(UTF8_BOM);
  });
});

describe("buildCsvFileName", () => {
  it("接頭辞と date-only 日付を繋いだファイル名を返す", () => {
    expect(buildCsvFileName("tasks", "2026-08-08")).toBe("tasks-2026-08-08.csv");
  });

  it("接頭辞が変わってもファイル名を組み立てられる", () => {
    expect(buildCsvFileName("overdue-tasks", "2026-01-05")).toBe("overdue-tasks-2026-01-05.csv");
  });
});
