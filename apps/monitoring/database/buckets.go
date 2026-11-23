package database

import (
	"errors"
	"math"
	"time"
)

// MaxBuckets bounds one bucketed answer, whatever range and step are asked.
const MaxBuckets = 2000

var (
	ErrInvalidRange   = errors.New("from must be before to")
	ErrInvalidStep    = errors.New("step must be at least one second")
	ErrTooManyBuckets = errors.New("the range holds too many buckets of this step")
)

// Stat summarises the readings of one metric in a bucket.
type Stat struct {
	Avg float64 `json:"avg"`
	Min float64 `json:"min"`
	Max float64 `json:"max"`
}

// Bucket is the readings whose time t satisfies start <= t < start+step,
// where start = from + i*step. Times are Unix seconds. A bucket without
// readings is not part of the answer.
type Bucket struct {
	Start float64 `json:"start"`
	// The first and last reading in the bucket, so a reader can tell an
	// outage between two buckets from readings that are merely far apart.
	First float64 `json:"first"`
	Last  float64 `json:"last"`
	Count int     `json:"count"`
	CPU   Stat    `json:"cpu"`
	// When the bucket's highest CPU reading was taken.
	CPUMaxAt float64 `json:"cpuMaxAt"`
	MemUsed  Stat    `json:"memUsed"`
	DiskUsed Stat    `json:"diskUsed"`
	// MB per second since the reading before; nil when no reading of the
	// bucket has one before it.
	NetworkIn  *Stat `json:"networkIn"`
	NetworkOut *Stat `json:"networkOut"`
}

// LatestReading is the newest reading kept, whatever range was asked.
type LatestReading struct {
	Timestamp string  `json:"timestamp"`
	CPU       float64 `json:"cpu"`
	CPUCores  int32   `json:"cpuCores"`
	MemUsed   float64 `json:"memUsed"`
	MemUsedGB float64 `json:"memUsedGB"`
	MemTotal  float64 `json:"memTotal"`
	DiskUsed  float64 `json:"diskUsed"`
	TotalDisk float64 `json:"totalDisk"`
	// MB per second since the reading before; nil for the only reading.
	NetworkIn  *float64 `json:"networkIn"`
	NetworkOut *float64 `json:"networkOut"`
}

type BucketedMetrics struct {
	From    float64        `json:"from"`
	To      float64        `json:"to"`
	Step    float64        `json:"step"`
	Buckets []Bucket       `json:"buckets"`
	Latest  *LatestReading `json:"latest"`
}

type accumulator struct {
	sum, min, max float64
	count         int
}

func (a *accumulator) add(value float64) {
	if a.count == 0 || value < a.min {
		a.min = value
	}
	if a.count == 0 || value > a.max {
		a.max = value
	}
	a.sum += value
	a.count++
}

func round(value float64, decimals int) float64 {
	scale := math.Pow(10, float64(decimals))
	return math.Round(value*scale) / scale
}

func (a *accumulator) stat(decimals int) Stat {
	return Stat{
		Avg: round(a.sum/float64(a.count), decimals),
		Min: round(a.min, decimals),
		Max: round(a.max, decimals),
	}
}

func (a *accumulator) statOrNil(decimals int) *Stat {
	if a.count == 0 {
		return nil
	}
	stat := a.stat(decimals)
	return &stat
}

func seconds(t time.Time) float64 {
	return float64(t.UnixNano()) / 1e9
}

// Timestamps are RFC 3339 strings in UTC whose fraction has no fixed length,
// so they sort by time only down to the second. A prefix cut at the second
// sorts before every reading of that second and after every earlier one.
func secondPrefix(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05")
}

// The network counters are megabytes since boot; a rate is what was added
// since the reading before, and zero when the counter started over.
func rate(now, before float64, elapsed time.Duration) float64 {
	return math.Max(0, (now-before)/elapsed.Seconds())
}

// GetBucketedMetrics returns the readings with from <= time < to grouped into
// buckets of `step` that start at `from`. It reads the rows in time order and
// keeps only the open bucket in memory, whatever the range holds.
func (db *DB) GetBucketedMetrics(from, to time.Time, step time.Duration) (*BucketedMetrics, error) {
	if !from.Before(to) {
		return nil, ErrInvalidRange
	}
	if step < time.Second {
		return nil, ErrInvalidStep
	}
	if (to.Sub(from)+step-1)/step > MaxBuckets {
		return nil, ErrTooManyBuckets
	}

	result := &BucketedMetrics{
		From:    seconds(from),
		To:      seconds(to),
		Step:    step.Seconds(),
		Buckets: []Bucket{},
	}

	var (
		hasPrevious                     bool
		previousAt                      time.Time
		previousIn, previousOut         float64
		timestamp                       string
		cpuValue, memValue, diskValue   float64
		networkInValue, networkOutValue float64
	)
	lower := secondPrefix(from)
	err := db.QueryRow(`
		SELECT timestamp, network_in, network_out FROM server_metrics
		WHERE timestamp < ? ORDER BY timestamp DESC LIMIT 1
	`, lower).Scan(&timestamp, &previousIn, &previousOut)
	if err == nil {
		if at, parseErr := time.Parse(time.RFC3339Nano, timestamp); parseErr == nil {
			previousAt, hasPrevious = at, true
		}
	}

	rows, err := db.Query(`
		SELECT timestamp, cpu, mem_used, disk_used, network_in, network_out
		FROM server_metrics
		WHERE timestamp >= ? AND timestamp < ?
		ORDER BY timestamp ASC
	`, lower, secondPrefix(to.Add(time.Second)))
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var (
		open                          *Bucket
		openIndex                     int64 = -1
		cpu, mem, disk, netIn, netOut accumulator
		cpuMaxAt                      time.Time
	)
	flush := func() {
		if open == nil {
			return
		}
		open.CPU = cpu.stat(2)
		open.CPUMaxAt = seconds(cpuMaxAt)
		open.MemUsed = mem.stat(2)
		open.DiskUsed = disk.stat(2)
		open.NetworkIn = netIn.statOrNil(5)
		open.NetworkOut = netOut.statOrNil(5)
		result.Buckets = append(result.Buckets, *open)
		open = nil
	}
	for rows.Next() {
		if err := rows.Scan(&timestamp, &cpuValue, &memValue, &diskValue, &networkInValue, &networkOutValue); err != nil {
			return nil, err
		}
		at, parseErr := time.Parse(time.RFC3339Nano, timestamp)
		if parseErr != nil {
			continue
		}
		if !at.Before(to) {
			break
		}
		elapsed := at.Sub(previousAt)
		hadPrevious := hasPrevious && elapsed > 0
		inRate, outRate := 0.0, 0.0
		if hadPrevious {
			inRate = rate(networkInValue, previousIn, elapsed)
			outRate = rate(networkOutValue, previousOut, elapsed)
		}
		previousAt, previousIn, previousOut, hasPrevious = at, networkInValue, networkOutValue, true
		if at.Before(from) {
			continue
		}

		index := int64(at.Sub(from) / step)
		if open == nil || index != openIndex {
			flush()
			openIndex = index
			open = &Bucket{
				Start: seconds(from.Add(time.Duration(index) * step)),
				First: seconds(at),
			}
			cpu, mem, disk, netIn, netOut = accumulator{}, accumulator{}, accumulator{}, accumulator{}, accumulator{}
		}
		open.Last = seconds(at)
		open.Count++
		if cpu.count == 0 || cpuValue > cpu.max {
			cpuMaxAt = at
		}
		cpu.add(cpuValue)
		mem.add(memValue)
		disk.add(diskValue)
		if hadPrevious {
			netIn.add(inRate)
			netOut.add(outRate)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	flush()

	latest, err := db.latestReading()
	if err != nil {
		return nil, err
	}
	result.Latest = latest
	return result, nil
}

func (db *DB) latestReading() (*LatestReading, error) {
	rows, err := db.Query(`
		SELECT timestamp, cpu, cpu_cores, mem_used, mem_used_gb, mem_total, disk_used, total_disk, network_in, network_out
		FROM server_metrics ORDER BY timestamp DESC LIMIT 2
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var latest *LatestReading
	var latestAt time.Time
	var latestIn, latestOut float64
	for rows.Next() {
		var reading LatestReading
		var networkIn, networkOut float64
		if err := rows.Scan(&reading.Timestamp, &reading.CPU, &reading.CPUCores, &reading.MemUsed, &reading.MemUsedGB, &reading.MemTotal, &reading.DiskUsed, &reading.TotalDisk, &networkIn, &networkOut); err != nil {
			return nil, err
		}
		at, parseErr := time.Parse(time.RFC3339Nano, reading.Timestamp)
		if latest == nil {
			if parseErr != nil {
				return nil, nil
			}
			reading.CPU = round(reading.CPU, 2)
			reading.MemUsed = round(reading.MemUsed, 2)
			reading.MemUsedGB = round(reading.MemUsedGB, 2)
			reading.MemTotal = round(reading.MemTotal, 2)
			reading.DiskUsed = round(reading.DiskUsed, 2)
			reading.TotalDisk = round(reading.TotalDisk, 2)
			latest, latestAt, latestIn, latestOut = &reading, at, networkIn, networkOut
			continue
		}
		if elapsed := latestAt.Sub(at); parseErr == nil && elapsed > 0 {
			in := round(rate(latestIn, networkIn, elapsed), 5)
			out := round(rate(latestOut, networkOut, elapsed), 5)
			latest.NetworkIn, latest.NetworkOut = &in, &out
		}
	}
	return latest, rows.Err()
}
