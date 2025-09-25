from typing import List, Union, Set, Optional
from collections import Counter
import random


def get_all_ballots(voters: List[List[Union[str, None]]]) -> Set[str]:
    all_ballots: Set[str] = set()
    for row in voters:
        for vote in row:
            if vote is not None:
                all_ballots.add(vote)
    return all_ballots



def clear_matrix(
    voters: List[List[Union[str, None]]], 
    frequency: Counter[str], 
    all_ballots: Set[str]
) -> List[List[Union[str, None]]]:
    # Track candidates present in the current front line (top preferences of each voter)
    front_line: Set[str] = set()
    for i in range(len(voters)):
        for j in range(len(voters[i])):
            current = voters[i][j]
            if current is not None:
                front_line.add(current)
                break
    
    
    # Candidates not in the front line have zero votes
    candidates_to_remove = all_ballots - front_line

    # Add candidates with the minimum votes
    min_votes = min(frequency.values(), default=0)
    candidates_to_remove |= {
        candidate for candidate, count in frequency.items() if count == min_votes
    }
    
    # Uncomment this line to implement randomised deletion (as is in Australian instant-runoff)
    # chosen_candidate = list(candidates_to_remove)[random.randint(1,len(candidates_to_remove)) - 1]
    # candidates_to_remove = chosen_candidate
    # print(f"CANDIDATES {candidates_to_remove}")

    # Remove candidates from the matrix
    for candidate in candidates_to_remove:
        for i in range(len(voters)):
            for j in range(len(voters[i])):
                if voters[i][j] is candidate:
                    if j < len(voters[i]) - 1:
                        voters[i][j] = voters[i][j+1]
                        voters[i][j+1] = None
                    else:
                        voters[i][j] = None
        for i in range(len(voters)):
            for j in range(len(voters[i])):
                if voters[i][j] == None:
                    if j < len(voters[i]) - 1:
                        voters[i][j] = voters[i][j+1]
                        voters[i][j+1] = None
        
        for i in range(len(voters)):
                voters[i].pop()

    print(f"CLEARED: {voters}")                   
    
    return voters


def runoff(voters: List[List[Union[str, None]]]) -> Optional[str]:
    half = len(voters) // 2

    while True:
        all_ballots = get_all_ballots(voters)
        
        # Count first-choice votes
        frequency: Counter[str] = Counter()
        for vote in voters:
            for candidate in vote:
                if candidate is not None:
                    frequency[candidate] += 1
                    break
                
        print(frequency)
        if not frequency:
            return None  # Complete tie (no candidates left)

        # Check if all remaining candidates are tied
        if len(set(frequency.values())) == 1 and len(frequency) > 1:
            return None  # Complete tie with multiple candidates remaining

        # Check if any candidate has more than half the votes
        most_common = frequency.most_common(1)
        if most_common and most_common[0][1] > half:
            return most_common[0][0]

        # Clear the least frequent candidates
        voters = clear_matrix(voters, frequency, all_ballots)
        print("VOTERS:")
        print(voters)
        
        
def check_validity(voters: List[List[Union[str, None]]]) -> Optional[bool]:
    # Function to confirm the following validty rules:
    # - Each person only cast one vote for a particular nominee (STV)
    # - Each person made at least one vote (not null)
    
    for vote in range(len(voters)):
        # Check not null
        valid_vote = False
        for j in range(len(voters[vote])):
            if voters[vote][j] != None:
                 valid_vote = True
                 
        if not valid_vote:
            print(f"INVALID VOTE NUMBER {vote}: {voters[vote]} - Empty ballot")
            return False
                 
        frequency: Counter[str] = Counter()
        for candidate in voters[vote]:
            if candidate is not None:
                frequency[candidate] += 1
        
        for vote_cast in frequency.values():
            if vote_cast > 1:
                print(f"INVALID VOTE NUMBER {vote}: {voters[vote]} - Multiple votes for same person")
                return False
        
    return True

def remove_invalid(voters: List[List[Union[str, None]]]) -> Optional[bool]:   
    votes_to_remove = []
     
    for vote in range(len(voters)):
        # Check not null
        valid_vote = False
        for j in range(len(voters[vote])):
            if voters[vote][j] != None:
                 valid_vote = True
                 
        if not valid_vote:
            votes_to_remove.append(vote)
            continue
                 
        frequency: Counter[str] = Counter()
        for candidate in voters[vote]:
            if candidate is not None:
                frequency[candidate] += 1
        
        for vote_cast in frequency.values():
            if vote_cast > 1:
                votes_to_remove.append(vote)
        
    for invalid_vote in votes_to_remove:
        voters.pop(invalid_vote)
        

if __name__ == "__main__":
    voters = [
    ["c", "a", "b", "e", "d"],
    ["d", "c", "a", "b", "e"],
    ["c", "a", "d", "e", "b"],
    ["e", "c", "b", "a", "d"],
    ["b", "c", "e", "a", "d"],
    ["a", "c", "e", "b", "d"],
    ["d", "c", "e", "a", "b"],
    ]
    
    if not check_validity(voters):
        answer = int(input("How would you like to proceed.\n (1) Remove invalid votes\n (2) Cancel election\n"))
        if answer == 1:
            print("Removing invalid votes...")
            remove_invalid(voters)
        elif answer == 2:
            print("Cancelling election...")
            exit()
            

    result = runoff(voters)
    print(result)  # Output: "e"