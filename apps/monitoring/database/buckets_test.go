package database

import (
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

var day = time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)

func at(offset time.Duration) time.Time { return day.Add(offset) }

type reading struct {
	at             time.Time
	cpu, mem, disk float64
	netIn, netOut  float64
}

func openTestDB(t *testing.T, readings ...reading) *DB {
	t.Helper()
	db, err := OpenDB(filepath.Join(t.TempDir(), "monitoring.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	for _, r := range readings {
		err := db.SaveMetric(ServerMetric{
			// As the collector writes it: UTC, fraction without trailing zeros.
			Timestamp: r.at.UTC().Format(time.RFC3339Nano),
			CPU:       r.cpu, CPUCores: 4,
			MemUsed: r.mem, MemUsedGB: r.mem * 0.16, MemTotal: 16,
			DiskUsed: r.disk, TotalDisk: 100,
			NetworkIn: r.netIn, NetworkOut: r.netOut,
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	return db
}

func buckets(t *testing.T, db *DB, from, to time.Time, step time.Duration) []Bucket {
	t.Helper()
	result, err := db.GetBucketedMetrics(from, to, step)
	if err != nil {
		t.Fatal(err)
	}
	return result.Buckets
}

func unix(t time.Time) float64 { return float64(t.UnixNano()) / 1e9 }

func TestBucketsAverageMinimumAndMaximum(t *testing.T) {
	db := openTestDB(t,
		reading{at: at(10 * time.Second), cpu: 10, mem: 40, disk: 50},
		reading{at: at(70 * time.Second), cpu: 30, mem: 42, disk: 50},
		reading{at: at(130 * time.Second), cpu: 80, mem: 47, disk: 51},
		reading{at: at(310 * time.Second), cpu: 5, mem: 30, disk: 51},
	)
	got := buckets(t, db, at(0), at(10*time.Minute), 5*time.Minute)
	if len(got) != 2 {
		t.Fatalf("want 2 buckets, got %d", len(got))
	}
	first := got[0]
	if first.Start != unix(at(0)) || first.Count != 3 {
		t.Errorf("first bucket: start %v count %d", first.Start, first.Count)
	}
	if first.First != unix(at(10*time.Second)) || first.Last != unix(at(130*time.Second)) {
		t.Errorf("first bucket spans %v..%v", first.First, first.Last)
	}
	if first.CPU != (Stat{Avg: 40, Min: 10, Max: 80}) {
		t.Errorf("cpu: %+v", first.CPU)
	}
	if first.CPUMaxAt != unix(at(130*time.Second)) {
		t.Errorf("cpu peak at %v", first.CPUMaxAt)
	}
	if first.MemUsed != (Stat{Avg: 43, Min: 40, Max: 47}) {
		t.Errorf("memory: %+v", first.MemUsed)
	}
	if first.DiskUsed != (Stat{Avg: 50.33, Min: 50, Max: 51}) {
		t.Errorf("disk: %+v", first.DiskUsed)
	}
	if got[1].Start != unix(at(5*time.Minute)) || got[1].Count != 1 || got[1].CPU.Avg != 5 {
		t.Errorf("second bucket: %+v", got[1])
	}
}

func TestBucketBoundaries(t *testing.T) {
	db := openTestDB(t,
		reading{at: at(-time.Millisecond), cpu: 1},
		// Sorts before "…T00:00:00Z" as text although it is later.
		reading{at: at(0).Add(500 * time.Millisecond), cpu: 2},
		reading{at: at(time.Minute), cpu: 3},
		reading{at: at(2*time.Minute - time.Millisecond), cpu: 4},
		reading{at: at(2 * time.Minute), cpu: 5},
	)
	got := buckets(t, db, at(0), at(2*time.Minute), time.Minute)
	if len(got) != 2 {
		t.Fatalf("want 2 buckets, got %+v", got)
	}
	// from is inclusive, a bucket edge belongs to the later bucket, to is
	// exclusive.
	if got[0].Count != 1 || got[0].CPU.Avg != 2 {
		t.Errorf("first bucket: %+v", got[0])
	}
	if got[1].Count != 2 || got[1].CPU.Min != 3 || got[1].CPU.Max != 4 {
		t.Errorf("second bucket: %+v", got[1])
	}

	exact := openTestDB(t,
		reading{at: at(0), cpu: 7},
		reading{at: at(time.Minute), cpu: 8},
	)
	got = buckets(t, exact, at(0), at(time.Minute), time.Minute)
	if len(got) != 1 || got[0].Count != 1 || got[0].CPU.Avg != 7 {
		t.Errorf("a reading exactly at from is in, exactly at to is out: %+v", got)
	}

	// A range that starts and ends inside a second.
	fractional := buckets(t, db, at(0).Add(600*time.Millisecond), at(time.Minute).Add(time.Millisecond), time.Hour)
	if len(fractional) != 1 || fractional[0].Count != 1 || fractional[0].CPU.Avg != 3 {
		t.Errorf("fractional bounds: %+v", fractional)
	}
}

func TestGapsAreAbsentNotZero(t *testing.T) {
	db := openTestDB(t,
		reading{at: at(30 * time.Second), cpu: 20},
		reading{at: at(3*time.Hour + 30*time.Second), cpu: 60},
	)
	result, err := db.GetBucketedMetrics(at(0), at(4*time.Hour), time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Buckets) != 2 {
		t.Fatalf("want the 2 buckets that have readings, got %d", len(result.Buckets))
	}
	if result.Buckets[0].Start != unix(at(0)) || result.Buckets[1].Start != unix(at(3*time.Hour)) {
		t.Errorf("starts: %v, %v", result.Buckets[0].Start, result.Buckets[1].Start)
	}
	// The outage shows as the distance between one bucket's last reading
	// and the next one's first.
	if result.Buckets[1].First-result.Buckets[0].Last != (3 * time.Hour).Seconds() {
		t.Errorf("outage length: %v", result.Buckets[1].First-result.Buckets[0].Last)
	}
	encoded, _ := json.Marshal(result)
	if strings.Contains(string(encoded), `"count":0`) {
		t.Errorf("an empty bucket was written: %s", encoded)
	}
}

func TestEmptyRangeAndEmptyDatabase(t *testing.T) {
	db := openTestDB(t, reading{at: at(time.Hour), cpu: 33, mem: 50, disk: 60})
	result, err := db.GetBucketedMetrics(at(2*time.Hour), at(3*time.Hour), time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(result)
	if !strings.Contains(string(encoded), `"buckets":[]`) {
		t.Errorf("an empty range is an empty list, got %s", encoded)
	}
	// The newest reading is reported whatever the range.
	if result.Latest == nil || result.Latest.CPU != 33 || result.Latest.CPUCores != 4 {
		t.Errorf("latest: %+v", result.Latest)
	}
	if result.Latest.NetworkIn != nil {
		t.Errorf("the only reading has no rate, got %v", *result.Latest.NetworkIn)
	}

	empty, err := openTestDB(t).GetBucketedMetrics(at(0), at(time.Hour), time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if len(empty.Buckets) != 0 || empty.Latest != nil {
		t.Errorf("empty database: %+v", empty)
	}
}

func TestStepLargerThanRange(t *testing.T) {
	db := openTestDB(t,
		reading{at: at(time.Minute), cpu: 10},
		reading{at: at(50 * time.Minute), cpu: 30},
		reading{at: at(61 * time.Minute), cpu: 90},
	)
	got := buckets(t, db, at(0), at(time.Hour), 24*time.Hour)
	if len(got) != 1 {
		t.Fatalf("want one bucket, got %d", len(got))
	}
	// One bucket starting at from; readings at or after to stay out.
	if got[0].Start != unix(at(0)) || got[0].Count != 2 || got[0].CPU.Max != 30 {
		t.Errorf("bucket: %+v", got[0])
	}
}

func TestNetworkRates(t *testing.T) {
	db := openTestDB(t,
		// Before the range: only what the first rate is measured from.
		reading{at: at(-60 * time.Second), netIn: 100, netOut: 10},
		reading{at: at(0), netIn: 160, netOut: 16},
		reading{at: at(60 * time.Second), netIn: 760, netOut: 16},
		// The counters started over (a reboot): no negative rate.
		reading{at: at(120 * time.Second), netIn: 5, netOut: 1},
		reading{at: at(180 * time.Second), netIn: 65, netOut: 31},
	)
	result, err := db.GetBucketedMetrics(at(0), at(4*time.Minute), 2*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	got := result.Buckets
	if len(got) != 2 {
		t.Fatalf("want 2 buckets, got %d", len(got))
	}
	// 1 MB/s then 10 MB/s: the peak survives, the average is beside it.
	if got[0].NetworkIn == nil || *got[0].NetworkIn != (Stat{Avg: 5.5, Min: 1, Max: 10}) {
		t.Errorf("in: %+v", got[0].NetworkIn)
	}
	if *got[0].NetworkOut != (Stat{Avg: 0.05, Min: 0, Max: 0.1}) {
		t.Errorf("out: %+v", got[0].NetworkOut)
	}
	if *got[1].NetworkIn != (Stat{Avg: 0.5, Min: 0, Max: 1}) {
		t.Errorf("in after the reset: %+v", got[1].NetworkIn)
	}
	if result.Latest.NetworkIn == nil || *result.Latest.NetworkIn != 1 || *result.Latest.NetworkOut != 0.5 {
		t.Errorf("latest rates: %v %v", result.Latest.NetworkIn, result.Latest.NetworkOut)
	}

	// The first reading ever has nothing to take a rate from.
	alone := buckets(t, openTestDB(t, reading{at: at(0), netIn: 50}), at(0), at(time.Minute), time.Minute)
	if len(alone) != 1 || alone[0].NetworkIn != nil || alone[0].NetworkOut != nil {
		t.Errorf("a bucket without a rate has null rates: %+v", alone)
	}
}

func TestNewestBucketsMatchTheFullRange(t *testing.T) {
	var readings []reading
	for i := 0; i < 600; i++ {
		// 137 ms past the minute: no reading falls exactly on a second.
		readings = append(readings, reading{
			at:    at(time.Duration(i)*time.Minute + 137*time.Millisecond),
			cpu:   float64(i % 97),
			netIn: float64(i * 3),
		})
	}
	db := openTestDB(t, readings...)
	to := at(600 * time.Minute)
	full := buckets(t, db, at(0), to, 30*time.Minute)
	// What a refresh asks for: from the start of the newest bucket it has.
	tail := buckets(t, db, at(570*time.Minute), to, 30*time.Minute)
	if len(full) != 20 || len(tail) != 1 {
		t.Fatalf("got %d and %d buckets", len(full), len(tail))
	}
	want, _ := json.Marshal(full[19])
	got, _ := json.Marshal(tail[0])
	if string(want) != string(got) {
		t.Errorf("the refreshed bucket differs:\n full %s\n tail %s", want, got)
	}
}

func TestBucketsDoNotDependOnTheTimeZone(t *testing.T) {
	db := openTestDB(t,
		reading{at: at(23*time.Hour + 30*time.Minute), cpu: 10},
		reading{at: at(24*time.Hour + 30*time.Minute), cpu: 20},
		reading{at: at(25*time.Hour + 30*time.Minute), cpu: 30},
	)
	from, to := at(22*time.Hour), at(26*time.Hour)
	original := time.Local
	t.Cleanup(func() { time.Local = original })

	var answers []string
	for _, name := range []string{"UTC", "Asia/Kolkata", "America/St_Johns", "Pacific/Kiritimati"} {
		zone, err := time.LoadLocation(name)
		if err != nil {
			t.Fatal(err)
		}
		time.Local = zone
		// The same instants, written on that zone's clock.
		result, err := db.GetBucketedMetrics(from.In(zone), to.In(zone), 2*time.Hour)
		if err != nil {
			t.Fatal(err)
		}
		encoded, _ := json.Marshal(result)
		answers = append(answers, string(encoded))
	}
	for i, answer := range answers {
		if answer != answers[0] {
			t.Errorf("zone %d answers differently:\n%s\n%s", i, answers[0], answer)
		}
	}
	var decoded BucketedMetrics
	if err := json.Unmarshal([]byte(answers[0]), &decoded); err != nil {
		t.Fatal(err)
	}
	// Buckets start at from, not at any zone's midnight.
	if len(decoded.Buckets) != 2 || decoded.Buckets[0].Start != unix(from) || decoded.Buckets[0].Count != 1 || decoded.Buckets[1].Count != 2 {
		t.Errorf("buckets: %+v", decoded.Buckets)
	}
}

func TestRangeAndStepAreChecked(t *testing.T) {
	db := openTestDB(t)
	cases := []struct {
		from, to time.Time
		step     time.Duration
		want     error
	}{
		{at(time.Hour), at(time.Hour), time.Minute, ErrInvalidRange},
		{at(time.Hour), at(0), time.Minute, ErrInvalidRange},
		{at(0), at(time.Hour), 0, ErrInvalidStep},
		{at(0), at(time.Hour), 500 * time.Millisecond, ErrInvalidStep},
		{at(0), at(30 * 24 * time.Hour), time.Minute, ErrTooManyBuckets},
		{at(0), at(MaxBuckets*time.Minute + time.Second), time.Minute, ErrTooManyBuckets},
	}
	for _, c := range cases {
		if _, err := db.GetBucketedMetrics(c.from, c.to, c.step); !errors.Is(err, c.want) {
			t.Errorf("%v..%v step %v: got %v, want %v", c.from, c.to, c.step, err, c.want)
		}
	}
	if _, err := db.GetBucketedMetrics(at(0), at(MaxBuckets*time.Minute), time.Minute); err != nil {
		t.Errorf("%d buckets are allowed: %v", MaxBuckets, err)
	}
}

func TestThirtyDaysOfMinutes(t *testing.T) {
	db, err := OpenDB(filepath.Join(t.TempDir(), "monitoring.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	const minutes = 30 * 24 * 60
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	insert, err := tx.Prepare(`INSERT INTO server_metrics (timestamp, cpu, cpu_cores, mem_used, mem_used_gb, mem_total, disk_used, total_disk, network_in, network_out) VALUES (?, ?, 4, 50, 8, 16, 40, 100, ?, ?)`)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < minutes; i++ {
		stamp := at(time.Duration(i)*time.Minute + 250*time.Millisecond).Format(time.RFC3339Nano)
		if _, err := insert.Exec(stamp, float64(i%100), float64(i), float64(i)/2); err != nil {
			t.Fatal(err)
		}
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}

	result, err := db.GetBucketedMetrics(at(0), at(30*24*time.Hour), 2*time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Buckets) != 360 {
		t.Fatalf("want 360 buckets, got %d", len(result.Buckets))
	}
	total := 0
	for _, bucket := range result.Buckets {
		total += bucket.Count
		if bucket.Count != 120 {
			t.Fatalf("bucket at %v holds %d readings", bucket.Start, bucket.Count)
		}
	}
	if total != minutes {
		t.Errorf("every reading is in exactly one bucket: %d of %d", total, minutes)
	}
	// One megabyte a minute, everywhere but the very first reading.
	last := result.Buckets[359]
	if last.NetworkIn.Max != 0.01667 || last.NetworkIn.Min != 0.01667 {
		t.Errorf("rate: %+v", last.NetworkIn)
	}
}
