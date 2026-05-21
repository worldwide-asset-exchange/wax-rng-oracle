import React from 'react';
import Job from './job.react';

function JobList(props) {
  const jobComponents = props.jobs.map((job) => (
    <Job
      key={job.id}
      id={job.id}
      signing_value={job.signing_value}
      caller={job.caller}
    />
  ));

  return (
    <table className="table">
      <thead>
      <tr>
        <th scope="col">Job</th>
        <th scope="col">Signing Value</th>
        <th scope="col">Caller</th>
      </tr>
      </thead>
      <tbody>
      {jobComponents}
      </tbody>
    </table>
  );
}

export default JobList
